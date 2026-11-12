// A real HTTP server around the real router, for the route tests that need a signed-in caller.
//
// Not a *.test.js file, so `node --test` does not run it on its own. Only the dependencies a
// handler receives are fakes; the route table, the auth middleware, the 404 and the error handler
// are the production ones, because those are what a request actually meets.
//
// `testConfig()` exists because `readEnv()` reads `process.env` and dotenv is loaded by index.js,
// not by a test: without an injected secret every token would be signed with an empty key.

const http = require("node:http");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { createRouter } = require("./routes");
const { readEnv } = require("./config/env");
const { notFound, errorHandler } = require("./middleware/error");

// 32 characters, which is the shortest the boot gate will start on. Not a secret: only a test
// signs with it.
const TEST_SECRET = "test-only-secret-0123456789abcdef";

function testConfig(env = {}) {
  return readEnv({ JWT_SECRET: TEST_SECRET, ...env });
}

// A token shaped exactly as controllers/auth.js issues one, so the middleware verifying it is the
// real one instead of a stub.
function tokenFor({ sub, role = "student", email = "student@example.test" } = {}) {
  return jwt.sign({ sub: String(sub), role, email }, TEST_SECRET, { expiresIn: "5m" });
}

async function startRouter(overrides = {}) {
  const config = overrides.config ?? testConfig();
  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.use(createRouter({ ...overrides, config, protectAuth: true }));
  app.use(notFound);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { body, token } = {}) => {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.cookie = `clario_token=${token}`;
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // A 204 has no body, so `.json()` would throw on the one response the contract says is empty.
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  return {
    base,
    get: (path, options) => call("GET", path, options),
    post: (path, body, options) => call("POST", path, { ...options, body }),
    put: (path, body, options) => call("PUT", path, { ...options, body }),
    patch: (path, body, options) => call("PATCH", path, { ...options, body }),
    delete: (path, options) => call("DELETE", path, options),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { TEST_SECRET, testConfig, tokenFor, startRouter };
