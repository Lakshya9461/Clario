// Unit tests for llm.js. No network: the LLM call is faked.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { z } = require("zod");
const { chat, chatJson, LlmBusyError, LlmError, DEFAULT_TIMEOUT_MS, timeoutFromEnv } = require("./llm");

const schema = z.object({ alpha: z.string() });
const fallback = { alpha: "fallback" };

function fakeChat(responses) {
  const calls = [];
  const fn = async (messages, options) => {
    calls.push({ messages, options });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}

test("valid JSON is returned as-is and not degraded", async () => {
  const { fn, calls } = fakeChat([JSON.stringify({ alpha: "one" })]);
  const result = await chatJson([{ role: "user", content: "hi" }], schema, fallback, { chat: fn });

  assert.deepEqual(result, { value: { alpha: "one" }, degraded: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.json, true, "chatJson must ask for a JSON object");
});

test("invalid then valid retries exactly once and is not degraded", async () => {
  const { fn, calls } = fakeChat([
    JSON.stringify({ alpha: 42 }),
    JSON.stringify({ alpha: "fixed" }),
  ]);
  const result = await chatJson([{ role: "user", content: "hi" }], schema, fallback, { chat: fn });

  assert.deepEqual(result, { value: { alpha: "fixed" }, degraded: false });
  assert.equal(calls.length, 2);
  // The retry quotes the rejected reply and the validator complaint, and asks again.
  const retryMessages = calls[1].messages;
  assert.equal(retryMessages.at(-2).role, "assistant");
  assert.match(retryMessages.at(-1).content, /rejected by the validator: alpha:/);
});

test("always invalid falls back after two attempts and is degraded", async () => {
  const { fn, calls } = fakeChat([JSON.stringify({ alpha: 1 })]);
  const result = await chatJson([{ role: "user", content: "hi" }], schema, fallback, { chat: fn });

  assert.deepEqual(result, { value: fallback, degraded: true, reason: "invalid" });
  assert.equal(calls.length, 2);
});

test("a reply that is not JSON falls back and is degraded", async () => {
  const { fn, calls } = fakeChat(["Sure! Here is your JSON: {alpha: 'x'}"]);
  const result = await chatJson([{ role: "user", content: "hi" }], schema, fallback, { chat: fn });

  assert.deepEqual(result, { value: fallback, degraded: true, reason: "invalid" });
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages.at(-1).content, /was not valid JSON/);
});

test("a transport failure falls back immediately and reports why", async () => {
  const { fn, calls } = fakeChat([new LlmError("LLM returned HTTP 500: boom")]);
  const result = await chatJson([{ role: "user", content: "hi" }], schema, fallback, { chat: fn });

  assert.deepEqual(result, { value: fallback, degraded: true, reason: "unavailable" });
  assert.equal(calls.length, 1);
});

test("a busy queue is thrown, not degraded", async () => {
  const { fn } = fakeChat([new LlmBusyError()]);
  await assert.rejects(
    chatJson([{ role: "user", content: "hi" }], schema, fallback, { chat: fn }),
    (error) => error instanceof LlmBusyError && error.status === 503 && error.code === "busy"
  );
});

test("chat allows 2 in flight, queues 3, and rejects the 6th as busy", async () => {
  const previousModel = process.env.LLM_MODEL;
  process.env.LLM_MODEL = "fake-model";

  const pending = [];
  const fetchImpl = () => {
    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    pending.push({ resolve });
    return promise;
  };
  const ok = () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    text: async () => "",
  });

  try {
    const calls = Array.from({ length: 6 }, () =>
      chat([{ role: "user", content: "x" }], { fetch: fetchImpl })
    );
    assert.equal(pending.length, 2, "two requests should be in flight");

    const settled = Promise.allSettled(calls);
    for (let round = 0; round < 12; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      while (pending.length) pending.shift().resolve(ok());
    }
    const results = await settled;

    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof LlmBusyError);
    assert.equal(rejected[0].reason.status, 503);
    assert.equal(rejected[0].reason.code, "busy");
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
  } finally {
    if (previousModel === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = previousModel;
  }
});

test("chat refuses to run without LLM_MODEL configured", async () => {
  const previousModel = process.env.LLM_MODEL;
  delete process.env.LLM_MODEL;
  try {
    await assert.rejects(
      chat([{ role: "user", content: "x" }], { fetch: async () => assert.fail("must not call out") }),
      (error) => error instanceof LlmError && /LLM_MODEL/.test(error.message)
    );
  } finally {
    if (previousModel !== undefined) process.env.LLM_MODEL = previousModel;
  }
});

test("LLM_TIMEOUT_MS raises the timeout, and bad values fall back to the default", () => {
  const previous = process.env.LLM_TIMEOUT_MS;
  try {
    process.env.LLM_TIMEOUT_MS = "240000";
    assert.equal(timeoutFromEnv(), 240000);
    for (const bad of ["", "abc", "0", "-5", undefined]) {
      process.env.LLM_TIMEOUT_MS = bad;
      assert.equal(timeoutFromEnv(), DEFAULT_TIMEOUT_MS, `should ignore ${JSON.stringify(bad)}`);
    }
  } finally {
    if (previous === undefined) delete process.env.LLM_TIMEOUT_MS;
    else process.env.LLM_TIMEOUT_MS = previous;
  }
});

// --- streaming -----------------------------------------------------------
// A slow model behind a proxy needs streaming: the proxy aborts a silent request. These fakes
// serve the stream as a real Response so the parsing path is exercised, not stubbed.

function sseResponse(lines, { contentLength } = {}) {
  const body = contentLength === undefined
    ? lines.join("\n")
    : lines.join("\n").slice(0, contentLength);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function sseChunk(content, extra = {}) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content, ...extra } }] })}`;
}

async function chatWith(fetchBody, fetchImpl) {
  const previousModel = process.env.LLM_MODEL;
  process.env.LLM_MODEL = "fake-model";
  try {
    return await chat([{ role: "user", content: "x" }], { fetch: fetchImpl });
  } finally {
    if (previousModel === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = previousModel;
  }
}

test("streams an event stream into one string and asks for stream: true", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return sseResponse([
      sseChunk(""),
      ": keep-alive",
      "",
      sseChunk('{"concepts":'),
      sseChunk("[]}"),
      "data: [DONE]",
    ]);
  };

  const content = await chatWith(null, fetchImpl);

  assert.equal(content, '{"concepts":[]}');
  assert.equal(seen[0].body.stream, true, "the request must ask the server to stream");
});

test("reasoning_content deltas never leak into the answer", async () => {
  const fetchImpl = async () =>
    sseResponse([
      sseChunk(null, { reasoning_content: "let me think about the topic" }),
      sseChunk('{"answer":'),
      sseChunk("1}"),
      "data: [DONE]",
    ]);

  assert.equal(await chatWith(null, fetchImpl), '{"answer":1}');
});

test("a stream that ends without [DONE] still returns what arrived", async () => {
  const fetchImpl = async () => sseResponse([sseChunk('{"partial":true}')]);
  assert.equal(await chatWith(null, fetchImpl), '{"partial":true}');
});

test("an empty stream is an error, not empty content", async () => {
  const fetchImpl = async () => sseResponse([": keep-alive", "", "data: [DONE]"]);
  await assert.rejects(chatWith(null, fetchImpl), (error) => {
    assert.ok(error instanceof LlmError);
    assert.match(error.message, /no content/i);
    return true;
  });
});

test("a server that ignores stream and answers JSON still works", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "plain" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  assert.equal(await chatWith(null, fetchImpl), "plain");
});

test("a JSON reply inside an event stream still validates through chatJson", async () => {
  const fetchImpl = async () => sseResponse([sseChunk('{"alpha":'), sseChunk('"streamed"}'), "data: [DONE]"]);
  const result = await chatJson([{ role: "user", content: "hi" }], schema, fallback, {
    chat: (messages, options) => chatWith(messages, fetchImpl),
  });

  assert.deepEqual(result, { value: { alpha: "streamed" }, degraded: false });
});
