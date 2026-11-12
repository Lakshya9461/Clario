// validate() is the one place a request body/params is checked with zod. It is deliberately thin:
// it parses, it writes the typed result back, and it hands a refusal to the central error handler
// as an error the route chose (so the contract's codes — invalid_topic, invalid_answer, not
// "invalid body" — stay the route's decision).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { z } = require("zod");
const { validate, InvalidRequestError } = require("./validate");
const { errorHandler } = require("./error");

async function serve(configure) {
  const app = express();
  app.use(express.json());
  configure(app);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, post: (path, body) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) };
}

const body = z.object({ name: z.string().trim().min(1), age: z.coerce.number().int().min(0) });

test("a valid body is parsed, coerced and handed on in req.body", async () => {
  const { server, post } = await serve((app) => {
    app.post("/thing", validate(body), (req, res) => res.json({ got: req.body }));
  });
  try {
    const response = await post("/thing", { name: "  ada  ", age: "36", extra: "dropped" });
    assert.equal(response.status, 200);
    // Trimmed and coerced by the schema; `extra` is gone because zod strips unknown keys.
    assert.deepEqual(await response.json(), { got: { name: "ada", age: 36 } });
  } finally {
    server.close();
  }
});

test("a refused body is a 400 through the central handler, and the route never runs", async () => {
  let ran = false;
  const { server, post } = await serve((app) => {
    app.post("/thing", validate(body), (req, res) => {
      ran = true;
      res.json({ ok: true });
    });
  });
  try {
    const response = await post("/thing", { name: "", age: 3 });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error, "invalid_request");
    assert.match(payload.message, /name/);
    assert.equal(ran, false);
  } finally {
    server.close();
  }
});

// The contract's error code belongs to the resource, not to the validator: a bad topic is
// invalid_topic, and it must stay invalid_topic after the body goes through zod.
test("a route can keep its own contract error code", async () => {
  class InvalidTopicError extends Error {
    constructor() {
      super("Enter a topic first.");
      this.status = 400;
      this.code = "invalid_topic";
      this.expose = true;
    }
  }
  const topicBody = z.object({ topic: z.string().trim().min(1) });
  const { server, post } = await serve((app) => {
    app.post("/session", validate(topicBody, { makeError: () => new InvalidTopicError() }), (req, res) =>
      res.json({ topic: req.body.topic })
    );
  });
  try {
    const response = await post("/session", { topic: "" });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_topic", message: "Enter a topic first." });
  } finally {
    server.close();
  }
});

// Express 5's req.query is a getter: writing the parsed value back over it would be a silent
// no-op, so a non-body source is only exposed as req.validated.
test("a params source lands in req.validated, leaving the request alone", async () => {
  const params = z.object({ id: z.string().regex(/^[0-9a-f]{4}$/) });
  const { server, post } = await serve((app) => {
    app.post("/item/:id", validate(params, { source: "params" }), (req, res) =>
      res.json({ validated: req.validated.params, params: req.params })
    );
  });
  try {
    const response = await post("/item/abcd", {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { validated: { id: "abcd" }, params: { id: "abcd" } });
  } finally {
    server.close();
  }
});

test("a request with no body at all is refused rather than parsed as undefined", async () => {
  const { server, post } = await serve((app) => {
    app.post("/thing", validate(body), (req, res) => res.json({ got: req.body }));
  });
  try {
    const response = await post("/thing", undefined);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_request");
  } finally {
    server.close();
  }
});

test("validate() refuses anything that is not a zod schema", () => {
  assert.throws(() => validate({ type: "object" }), TypeError);
  assert.throws(() => validate(undefined), TypeError);
});

test("InvalidRequestError is a plain 400 that the handler may show", () => {
  const error = new InvalidRequestError([{ path: ["name"], message: "Too small" }]);
  assert.equal(error.status, 400);
  assert.equal(error.expose, true);
  assert.equal(error.code, "invalid_request");
  assert.match(error.message, /name: Too small/);
});
