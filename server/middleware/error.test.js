// Error mapping tests: the client sees the contract's { error, message }, and nothing
// internal leaks. Uses the real error classes from llm.js and generate.js.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { toHttpError, notFound, errorHandler } = require("./error");
const { LlmBusyError, LlmError } = require("../llm");
const { InvalidTopicError, TopicNotSupportedError, GenerationUnavailableError } = require("../packs/generate");

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

// --- the two catch-all middlewares ---------------------------------------
// Called with a fake res so the shape of the answer is asserted directly, without a server.

function fakeRes() {
  const calls = { status: null, json: null, ended: false };
  const res = {
    headersSent: false,
    status(code) {
      calls.status = code;
      return res;
    },
    json(body) {
      calls.json = body;
      return res;
    },
  };
  return { res, calls };
}

test("a wrong path is a JSON 404 that names the request", () => {
  const { res, calls } = fakeRes();
  notFound({ method: "GET", path: "/nope" }, res);
  assert.equal(calls.status, 404);
  assert.deepEqual(calls.json, { error: "not_found", message: "No route for GET /nope" });
});

test("the handler answers with the mapped status and body", () => {
  const { res, calls } = fakeRes();
  const error = Object.assign(new Error("Enter a topic first."), {
    status: 400,
    code: "invalid_topic",
    expose: true,
  });
  errorHandler(error, {}, res, () => assert.fail("must not delegate"));
  assert.equal(calls.status, 400);
  assert.deepEqual(calls.json, { error: "invalid_topic", message: "Enter a topic first." });
});

// Once bytes are sent Express must close the connection itself: a second response here would
// throw ERR_HTTP_HEADERS_SENT instead of ending the request.
test("an error after the headers are sent is passed back to Express", () => {
  const { res } = fakeRes();
  res.headersSent = true;
  let passed;
  errorHandler(new Error("late"), {}, res, (error) => {
    passed = error;
  });
  assert.equal(passed.message, "late");
});
