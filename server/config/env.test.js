// The environment is read in exactly one place. These tests pin the two jobs it has:
// every variable is parsed once into one object, and the bootstrap refuses to start without the
// values the app cannot invent — naming each one, never printing a value.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  readEnv,
  assertBootable,
  ConfigError,
  DEFAULT_PORT,
  DEFAULT_MONGO_URL,
  DEFAULT_CLIENT_ORIGIN,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_JWT_EXPIRES_IN,
  MIN_JWT_SECRET_LENGTH,
} = require("./env");

const SECRET = "x".repeat(MIN_JWT_SECRET_LENGTH);

test("an empty environment still yields a complete config", () => {
  assert.deepEqual(readEnv({}), {
    nodeEnv: "development",
    isProduction: false,
    port: DEFAULT_PORT,
    mongoUrl: DEFAULT_MONGO_URL,
    clientOrigin: DEFAULT_CLIENT_ORIGIN,
    jwt: { secret: "", expiresIn: DEFAULT_JWT_EXPIRES_IN, cookieSecure: false },
    admin: { email: "", password: "" },
    llm: { baseUrl: DEFAULT_LLM_BASE_URL, model: "", apiKey: "", timeoutMs: DEFAULT_LLM_TIMEOUT_MS },
    rateLimit: { max: undefined, windowMs: undefined },
  });
});

test("values are parsed to their types, not passed through as strings", () => {
  const config = readEnv({
    NODE_ENV: "production",
    PORT: "8080",
    MONGO_URL: "mongodb://db:27017/clario",
    CLIENT_ORIGIN: "https://clario.example.test",
    JWT_SECRET: SECRET,
    JWT_EXPIRES_IN: "1h",
    COOKIE_SECURE: "true",
    ADMIN_EMAIL: "admin@clario.example.test",
    ADMIN_PASSWORD: "pw",
    LLM_BASE_URL: "http://10.0.0.5:8080/v1/",
    LLM_MODEL: "some-model",
    LLM_API_KEY: "key",
    LLM_TIMEOUT_MS: "240000",
    RATE_LIMIT_MAX: "600",
    RATE_LIMIT_WINDOW_MS: "30000",
  });

  assert.equal(config.isProduction, true);
  assert.equal(config.port, 8080);
  assert.equal(config.clientOrigin, "https://clario.example.test");
  assert.equal(config.jwt.secret, SECRET);
  assert.equal(config.jwt.expiresIn, "1h");
  assert.equal(config.jwt.cookieSecure, true);
  assert.equal(config.llm.timeoutMs, 240000);
  assert.deepEqual(config.rateLimit, { max: 600, windowMs: 30000 });
});

// Several places rely on an unreadable cap keeping the documented default instead of taking the
// server down (`llm.test.js`, `rate-limit.test.js`): a typo must not be a boot failure.
test("unreadable numbers keep the default instead of throwing", () => {
  for (const bad of ["", "abc", "0", "-5", "undefined"]) {
    const config = readEnv({ PORT: bad, LLM_TIMEOUT_MS: bad, RATE_LIMIT_MAX: bad, RATE_LIMIT_WINDOW_MS: bad });
    assert.equal(config.port, DEFAULT_PORT, `PORT ${JSON.stringify(bad)}`);
    assert.equal(config.llm.timeoutMs, DEFAULT_LLM_TIMEOUT_MS, `LLM_TIMEOUT_MS ${JSON.stringify(bad)}`);
    assert.deepEqual(config.rateLimit, { max: undefined, windowMs: undefined }, `RATE_LIMIT ${JSON.stringify(bad)}`);
  }
});

// A malformed origin is a CORS refusal the browser shows as "cannot reach the server", so it must
// not silently become a wildcard or break the parse.
test("a malformed client origin falls back to the dev origin", () => {
  assert.equal(readEnv({ CLIENT_ORIGIN: "not a url" }).clientOrigin, DEFAULT_CLIENT_ORIGIN);
});

// The cookie must be Secure in production, and a plain-http dev server cannot set one.
test("COOKIE_SECURE follows the deployment, and an explicit value wins", () => {
  assert.equal(readEnv({}).jwt.cookieSecure, false);
  assert.equal(readEnv({ NODE_ENV: "production" }).jwt.cookieSecure, true);
  assert.equal(readEnv({ NODE_ENV: "production", COOKIE_SECURE: "false" }).jwt.cookieSecure, false);
  assert.equal(readEnv({ COOKIE_SECURE: "1" }).jwt.cookieSecure, true);
});

test("booting without MONGO_URL or JWT_SECRET names both, and prints no value", () => {
  assert.throws(
    () => assertBootable({ MONGO_URL: "", JWT_SECRET: "" }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.deepEqual(error.problems.map((problem) => problem.name), ["MONGO_URL", "JWT_SECRET"]);
      assert.match(error.message, /MONGO_URL/);
      assert.match(error.message, /JWT_SECRET/);
      assert.match(error.message, /\.env\.example/);
      return true;
    }
  );
});

// A secret short enough to guess is the same failure as a missing one, and the complaint must not
// echo the secret it just rejected.
test("a too-short JWT_SECRET is refused without printing it", () => {
  const short = "abc123";
  assert.throws(
    () => assertBootable({ MONGO_URL: DEFAULT_MONGO_URL, JWT_SECRET: short }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.deepEqual(error.problems, [
        { name: "JWT_SECRET", reason: `is shorter than ${MIN_JWT_SECRET_LENGTH} characters` },
      ]);
      assert.equal(error.message.includes(short), false);
      return true;
    }
  );
});

test("a complete environment passes and comes back parsed", () => {
  const config = assertBootable({ MONGO_URL: "mongodb://db:27017/clario", JWT_SECRET: SECRET });
  assert.equal(config.mongoUrl, "mongodb://db:27017/clario");
  assert.equal(config.jwt.secret, SECRET);
});
