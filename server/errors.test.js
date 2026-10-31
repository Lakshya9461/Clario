// Error mapping tests: the client sees the contract's { error, message }, and nothing
// internal leaks. Uses the real error classes from llm.js and generate.js.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { toHttpError } = require("./errors");
const { LlmBusyError, LlmError } = require("./llm");
const { InvalidTopicError, TopicNotSupportedError, GenerationUnavailableError } = require("./packs/generate");

test("a busy queue becomes 503 with error busy", () => {
  const { status, body } = toHttpError(new LlmBusyError());
  assert.equal(status, 503);
  assert.equal(body.error, "busy");
  assert.match(body.message, /busy/i);
});

test("an invalid topic becomes 400 with error invalid_topic", () => {
  const { status, body } = toHttpError(new InvalidTopicError("Enter a topic first."));
  assert.equal(status, 400);
  assert.deepEqual(body, { error: "invalid_topic", message: "Enter a topic first." });
});

test("an unsupported topic becomes 422 with error topic_not_supported", () => {
  const { status, body } = toHttpError(new TopicNotSupportedError());
  assert.equal(status, 422);
  assert.equal(body.error, "topic_not_supported");
});

test("an unreachable model becomes 503 with error generation_unavailable", () => {
  const { status, body } = toHttpError(new GenerationUnavailableError());
  assert.equal(status, 503);
  assert.equal(body.error, "generation_unavailable");
});

test("an LLM failure is reported as a generic server error", () => {
  const { status, body } = toHttpError(new LlmError("LLM returned HTTP 500: internal detail"));
  assert.equal(status, 502);
  assert.deepEqual(body, { error: "server_error", message: "Something went wrong." });
  assert.doesNotMatch(body.message, /internal detail/);
});

test("an unknown error is a generic 500 that never echoes its message", () => {
  const { status, body } = toHttpError(new Error("connection string rejected: secret"));
  assert.equal(status, 500);
  assert.deepEqual(body, { error: "server_error", message: "Something went wrong." });
});

test("a non-exposed client error keeps its code but is still a 4xx", () => {
  const error = Object.assign(new Error("Bad JSON body."), { status: 400 });
  const { status, body } = toHttpError(error);
  assert.equal(status, 400);
  assert.deepEqual(body, { error: "bad_request", message: "Bad JSON body." });
});
