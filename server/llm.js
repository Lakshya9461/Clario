// The ONLY file that talks to the LLM (Strata, an OpenAI-compatible local server).
// Nothing here knows about topics, packs, students or answers: callers pass messages,
// a zod schema and a fallback. Rule 2: on invalid output retry once, then fall back and
// report "degraded". Rule 9: prompts and answers are never logged.

const DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";
// Generation asks for ~2k tokens of JSON, which a slow model can take well over a minute to
// produce. A local default keeps the beta responsive; LLM_TIMEOUT_MS raises it for a model that
// needs longer without changing any call site.
const DEFAULT_TIMEOUT_MS = 90_000;

function timeoutFromEnv() {
  const value = Number(process.env.LLM_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}
const TEMPERATURE = 0.3;

// Queue: at most 2 requests in flight, at most 3 waiting behind them.
const MAX_CONCURRENT = 2;
const MAX_QUEUED = 3;

class LlmBusyError extends Error {
  constructor() {
    super("The study assistant is busy. Try again in a moment.");
    this.name = "LlmBusyError";
    this.status = 503;
    this.code = "busy";
    this.expose = true; // the route answers 503 { error: "busy" }
  }
}

class LlmError extends Error {
  constructor(message) {
    super(message);
    this.name = "LlmError";
    this.status = 502;
    this.code = "llm_error";
  }
}

let active = 0;
const waiting = [];

async function runQueued(task) {
  active += 1;
  try {
    return await task();
  } finally {
    active -= 1;
    drain();
  }
}

function drain() {
  while (active < MAX_CONCURRENT && waiting.length) {
    const next = waiting.shift();
    runQueued(next.task).then(next.resolve, next.reject);
  }
}

function withQueue(task) {
  if (active < MAX_CONCURRENT) return runQueued(task);
  if (waiting.length >= MAX_QUEUED) throw new LlmBusyError();
  return new Promise((resolve, reject) => waiting.push({ task, resolve, reject }));
}

function requireModel() {
  const model = process.env.LLM_MODEL;
  if (!model) throw new LlmError("LLM_MODEL is not configured.");
  return model;
}

// Reads a server-sent-event stream and returns the concatenated assistant text. `reasoning_content`
// deltas are deliberately dropped: they are the model's scratchpad, not its answer, and would
// corrupt the JSON we parse. `: keep-alive` comments and blank lines are ignored.
async function readEventStream(response) {
  const stream = response.body;
  if (!stream || typeof stream.getReader !== "function") {
    throw new LlmError("LLM returned an event stream with no body.");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let done = false;

  // Returns true when the stream signalled its end.
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false; // blank lines and ": keep-alive"
    const payload = trimmed.slice("data:".length).trim();
    if (payload === "[DONE]") return true;

    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return false; // a partial or non-JSON event is not fatal; the answer may still arrive
    }

    const delta = event?.choices?.[0]?.delta;
    if (typeof delta?.content === "string") content += delta.content;
    return false;
  };

  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;

    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (handleLine(line)) {
        done = true;
        break;
      }
    }
  }

  // A stream can end without a trailing newline; the last line still counts.
  if (!done && buffer) handleLine(buffer);

  reader.cancel().catch(() => {});
  return content;
}

// One completion. Returns the message content as a string.
// options: { json?: boolean, timeoutMs?: number, fetch?: typeof fetch }  (fetch is for tests)
async function chat(messages, options = {}) {
  const {
    json = false,
    timeoutMs = timeoutFromEnv(),
    fetch: fetchImpl = globalThis.fetch,
  } = options;

  return withQueue(async () => {
    const model = requireModel();
    const baseUrl = (process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const apiKey = process.env.LLM_API_KEY;

    // Streaming is what makes a slow model usable: a proxy in front of the LLM (Cloudflare, for
    // one) gives up on a request with no bytes after ~100s, but keeps a stream open. The server
    // may ignore `stream` and answer with one JSON body; both are handled below.
    const body = { model, messages, temperature: TEMPERATURE, stream: true };
    if (json) body.response_format = { type: "json_object" };

    let response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason =
        error.name === "TimeoutError"
          ? `no response within ${timeoutMs}ms`
          : `request failed (${error.message})`;
      throw new LlmError(`LLM ${reason}.`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new LlmError(`LLM returned HTTP ${response.status}: ${detail.slice(0, 200)}`);
    }

    const contentType = response.headers?.get?.("content-type") || "";
    let content;
    try {
      content = contentType.includes("text/event-stream")
        ? await readEventStream(response)
        : (await response.json())?.choices?.[0]?.message?.content;
    } catch (error) {
      if (error instanceof LlmError) throw error;
      const reason =
        error.name === "TimeoutError"
          ? `stream did not finish within ${timeoutMs}ms`
          : `stream failed (${error.message})`;
      throw new LlmError(`LLM ${reason}.`);
    }

    if (typeof content !== "string" || !content.trim()) {
      throw new LlmError("LLM returned no content.");
    }
    return content;
  });
}

// Ask for JSON and validate it. Exactly one retry, then the fallback plus degraded: true.
// Network/timeout failures fall back immediately: a second 90s wait helps nobody.
// A busy queue is NOT degraded: it is thrown so the route can answer 503 { error: "busy" }.
//
// `reason` says why a fallback happened, because "the model could not be reached" and "the
// model replied nonsense" deserve different answers: "unavailable" or "invalid".
async function chatJson(messages, schema, fallback, options = {}) {
  const call = options.chat || chat;
  const chatOptions = { json: true, timeoutMs: options.timeoutMs, fetch: options.fetch };

  let lastContent = null;
  let lastIssues = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let content;
    try {
      const attemptMessages =
        attempt === 1 ? messages : [...messages, ...retryMessages(lastContent, lastIssues)];
      content = await call(attemptMessages, chatOptions);
    } catch (error) {
      if (error instanceof LlmBusyError) throw error;
      // The message says which request failed and why (status, timeout, transport). It never
      // contains the prompt or the answer, so this is safe to log and is the only way to tell
      // "the server rejected us" from "the network is down" without guessing.
      console.warn(`[llm] request failed: ${error.message}`);
      return { value: fallback, degraded: true, reason: "unavailable" };
    }

    lastContent = content;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      lastIssues = ["the reply was not valid JSON"];
      continue;
    }

    const result = schema.safeParse(parsed);
    if (result.success) return { value: result.data, degraded: false };

    lastIssues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }

  return { value: fallback, degraded: true, reason: "invalid" };
}

function retryMessages(lastContent, issues) {
  return [
    { role: "assistant", content: String(lastContent ?? "").slice(0, 2000) },
    {
      role: "user",
      content:
        `That reply was rejected by the validator: ${issues.join("; ")}. ` +
        "Reply again with a single JSON object that matches the requested shape.",
    },
  ];
}

module.exports = {
  chat,
  chatJson,
  LlmBusyError,
  LlmError,
  DEFAULT_TIMEOUT_MS,
  timeoutFromEnv,
  MAX_CONCURRENT,
  MAX_QUEUED,
};
