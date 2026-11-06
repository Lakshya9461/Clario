// The limit as the browser meets it: one process, real HTTP, no Mongo (nothing on these paths
// touches the store). Run with: npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const app = require("./app");
const { MAX_REQUESTS } = require("./rate-limit");

let base;
const server = http.createServer(app);

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const get = (path, headers = {}) => fetch(`${base}${path}`, { headers });

test("health answers, and keeps answering while the caller is being limited", async () => {
  assert.equal((await get("/health")).status, 200);

  for (let i = 0; i < MAX_REQUESTS; i += 1) await get("/no-such-route");
  assert.equal((await get("/no-such-route")).status, 429);

  // A monitor must not be able to make the app look down, so health is outside the window.
  assert.equal((await get("/health")).status, 200);
});

test("the refusal is a clear 429 the browser can read", async () => {
  const response = await get("/no-such-route", { Origin: "http://localhost:5173" });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
  assert.ok(Number(response.headers.get("retry-after")) > 0);

  const body = await response.json();
  assert.equal(body.error, "rate_limited");
  assert.match(body.message, /Try again in \d+ seconds/);
});
