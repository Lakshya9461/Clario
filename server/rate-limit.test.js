// Unit tests for the per-address request limit. Run with: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { rateLimit, limitFromEnv, MAX_REQUESTS, WINDOW_MS } = require("./rate-limit");

function call(limit, { method = "POST", ip = "203.0.113.7" } = {}) {
  const req = { method, ip, socket: { remoteAddress: ip } };
  const headers = {};
  const result = { passed: false, status: 200, body: null, headers };
  const res = {
    set(name, value) {
      headers[name] = value;
      return res;
    },
    status(code) {
      result.status = code;
      return res;
    },
    json(body) {
      result.body = body;
      return res;
    },
  };
  limit(req, res, () => {
    result.passed = true;
  });
  return result;
}

test("allows the limit, then answers 429 with a Retry-After", () => {
  const limit = rateLimit({ windowMs: 60_000, max: 2 });

  assert.equal(call(limit).passed, true);
  assert.equal(call(limit).passed, true);

  const refused = call(limit);
  assert.equal(refused.passed, false);
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, "rate_limited");
  assert.match(refused.body.message, /Try again in \d+ seconds/);
  assert.equal(refused.headers["Retry-After"], "60");
});

test("counts addresses separately", () => {
  const limit = rateLimit({ windowMs: 60_000, max: 1 });

  assert.equal(call(limit, { ip: "198.51.100.4" }).passed, true);
  assert.equal(call(limit, { ip: "198.51.100.4" }).passed, false);
  assert.equal(call(limit, { ip: "198.51.100.5" }).passed, true);
});

test("a fresh window allows requests again", () => {
  let nowMs = 1_000;
  const limit = rateLimit({ windowMs: 60_000, max: 1, now: () => nowMs });

  assert.equal(call(limit).passed, true);
  assert.equal(call(limit).passed, false);

  nowMs += 60_000;
  assert.equal(call(limit).passed, true);
});

test("does not spend the allowance on CORS preflight", () => {
  const limit = rateLimit({ windowMs: 60_000, max: 1 });

  for (let i = 0; i < 5; i += 1) assert.equal(call(limit, { method: "OPTIONS" }).passed, true);
  assert.equal(call(limit).passed, true);
});

test("sweeps expired windows instead of keeping every address", () => {
  let nowMs = 0;
  const limit = rateLimit({ windowMs: 1_000, max: 1, now: () => nowMs });

  assert.equal(call(limit, { ip: "198.51.100.9" }).passed, true);
  assert.equal(call(limit, { ip: "198.51.100.9" }).passed, false);

  nowMs += 1_000;
  assert.equal(call(limit, { ip: "198.51.100.9" }).passed, true);
  assert.equal(call(limit, { ip: "198.51.100.9" }).passed, false);
});

test("the allowance is configurable, and an unreadable value keeps the default", () => {
  assert.deepEqual(limitFromEnv({ RATE_LIMIT_MAX: "600", RATE_LIMIT_WINDOW_MS: "30000" }), {
    max: 600,
    windowMs: 30000,
  });
  assert.deepEqual(limitFromEnv({}), { max: undefined, windowMs: undefined });
  assert.deepEqual(limitFromEnv({ RATE_LIMIT_MAX: "lots", RATE_LIMIT_WINDOW_MS: "-1" }), {
    max: undefined,
    windowMs: undefined,
  });
  // Undefined means "keep rateLimit's own default", which is the beta allowance.
  const limit = rateLimit(limitFromEnv({}));
  for (let i = 0; i < MAX_REQUESTS; i += 1) assert.equal(call(limit).passed, true);
  assert.equal(call(limit).passed, false);
  assert.equal(WINDOW_MS, 60_000);
});
