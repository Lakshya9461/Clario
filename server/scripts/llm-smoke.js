// Manual smoke test for the local Strata server. Run from server/: npm run smoke
// Sends one plain-text prompt and one JSON prompt and reports timing + validity.
// It prints no prompts from students and never prints the API key.

require("dotenv").config();
const { z } = require("zod");
const { chat, chatJson, LlmBusyError, LlmError } = require("../llm");

const jsonSchema = z.object({
  status: z.enum(["ready"]),
  echoes: z.string().min(1),
});

async function timed(label, fn) {
  const started = performance.now();
  try {
    const result = await fn();
    const ms = Math.round(performance.now() - started);
    console.log(`✔ ${label} in ${ms} ms`);
    return result;
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    const kind = error instanceof LlmBusyError ? "busy" : error instanceof LlmError ? "llm" : "unexpected";
    console.log(`✘ ${label} in ${ms} ms — ${kind}: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log(`base url : ${process.env.LLM_BASE_URL || "http://127.0.0.1:8080/v1 (default)"}`);
  console.log(`model    : ${process.env.LLM_MODEL || "(LLM_MODEL is not set — requests will fail)"}`);
  console.log(`api key  : ${process.env.LLM_API_KEY ? "set" : "not set"}`);
  console.log("");

  let failed = false;

  const text = await timed("text prompt", () =>
    chat([
      { role: "system", content: "You answer with one word and nothing else." },
      { role: "user", content: "Reply with the single word: ready" },
    ])
  );
  if (text === null) failed = true;
  else console.log(`  reply length: ${text.trim().length} chars, first line: ${text.trim().split("\n")[0].slice(0, 60)}`);

  const json = await timed("json prompt", () =>
    chatJson(
      [
        { role: "system", content: "You reply with one JSON object and nothing else." },
        {
          role: "user",
          content:
            'Reply with exactly this JSON shape: {"status":"ready","echoes":"<the word ready>"}',
        },
      ],
      jsonSchema,
      { status: "ready", echoes: "fallback" }
    )
  );
  if (json === null) failed = true;
  else if (json.degraded) {
    failed = true;
    console.log("  ✘ degraded: no valid JSON after the retry (or the request failed)");
  } else console.log(`  degraded: false, value: ${JSON.stringify(json.value)}`);

  console.log("");
  console.log(failed ? "smoke test FAILED" : "smoke test OK");
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(`smoke test crashed: ${error.message}`);
  process.exitCode = 1;
});
