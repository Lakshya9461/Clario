// redactUrl is the only part of db.js that can be tested without a database: it is also the
// part that must never get a password wrong, because its output goes to logs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { redactUrl, mongoUrl, DEFAULT_MONGO_URL } = require("./db");

test("redacts the password of a mongodb url", () => {
  assert.equal(
    redactUrl("mongodb://alice:s3cret@127.0.0.1:27017/clario"),
    "mongodb://alice:<redacted>@127.0.0.1:27017/clario"
  );
});

test("redacts the password of an srv url", () => {
  assert.equal(
    redactUrl("mongodb+srv://alice:s3cret@cluster0.example.mongodb.net/clario?retryWrites=true"),
    "mongodb+srv://alice:<redacted>@cluster0.example.mongodb.net/clario?retryWrites=true"
  );
});

test("redacts a password containing colons and at signs", () => {
  assert.equal(
    redactUrl("mongodb://alice:a:b@c@host/clario"),
    "mongodb://alice:<redacted>@host/clario"
  );
});

test("leaves a url without credentials alone", () => {
  assert.equal(redactUrl("mongodb://127.0.0.1:27017/clario"), "mongodb://127.0.0.1:27017/clario");
});

test("does not leak a password when the url is not a mongo url", () => {
  assert.equal(redactUrl("http://user:pw@example.test/"), "http://user:<redacted>@example.test/");
});

test("falls back to the local default when MONGO_URL is unset", () => {
  const previous = process.env.MONGO_URL;
  delete process.env.MONGO_URL;
  try {
    assert.equal(mongoUrl(), DEFAULT_MONGO_URL);
  } finally {
    if (previous !== undefined) process.env.MONGO_URL = previous;
  }
});
