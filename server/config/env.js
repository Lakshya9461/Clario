// The ONE place that reads `process.env`.
//
// Two jobs, kept apart on purpose:
//   readEnv()        parses every variable into one typed object. It never throws: a cap that
//                    nobody can read keeps its documented default (a typo in RATE_LIMIT_MAX must
//                    not take the server down), and a missing value falls back to what the code
//                    would have used anyway. Libraries call this, so a test can hand it a fake
//                    environment.
//   assertBootable() is the bootstrap's gate. It refuses to start without the values the app
//                    cannot invent, and its message names variables only — never a value, because
//                    boot output is a log (rule 9: no secrets in logs).
//
// Everything downstream (`db.js`, `llm.js`, `rate-limit.js`, `app.js`, `index.js`) goes through
// here instead of touching `process.env`, so this file is the whole list of settings.

const { z } = require("zod");

const DEFAULT_PORT = 3000;
const DEFAULT_MONGO_URL = "mongodb://127.0.0.1:27017/clario";
const DEFAULT_CLIENT_ORIGIN = "http://localhost:5173";
const DEFAULT_LLM_BASE_URL = "http://127.0.0.1:8080/v1";
const DEFAULT_LLM_TIMEOUT_MS = 90_000;
const DEFAULT_JWT_EXPIRES_IN = "7d";
// A JWT signed with a short secret is a forgeable JWT: 32 characters is the shortest value we will
// boot on, and `.env.example` tells the operator how to generate a longer one.
const MIN_JWT_SECRET_LENGTH = 32;

// An unreadable positive integer (empty, "abc", 0, -5, the string "undefined") keeps the default.
const positiveInt = z.coerce.number().int().positive();

// Only an explicit truthy spelling turns a flag on; "0"/"false"/"no" turn it off, and unset or
// empty leaves the decision to the caller (see COOKIE_SECURE, which follows NODE_ENV).
const flag = z.preprocess(
  (value) =>
    value === undefined || String(value).trim() === ""
      ? undefined
      : /^(1|true|yes|on)$/i.test(String(value).trim()),
  z.boolean().optional()
);

const schema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: positiveInt.catch(DEFAULT_PORT),
  MONGO_URL: z.string().trim().min(1).catch(DEFAULT_MONGO_URL),
  CLIENT_ORIGIN: z.string().trim().url().catch(DEFAULT_CLIENT_ORIGIN),

  JWT_SECRET: z.string().catch(""),
  JWT_EXPIRES_IN: z.string().trim().min(1).catch(DEFAULT_JWT_EXPIRES_IN),
  COOKIE_SECURE: flag,
  ADMIN_EMAIL: z.string().trim().catch(""),
  ADMIN_PASSWORD: z.string().catch(""),

  LLM_BASE_URL: z.string().trim().url().catch(DEFAULT_LLM_BASE_URL),
  LLM_MODEL: z.string().trim().catch(""),
  LLM_API_KEY: z.string().catch(""),
  LLM_TIMEOUT_MS: positiveInt.catch(DEFAULT_LLM_TIMEOUT_MS),

  RATE_LIMIT_MAX: positiveInt.optional().catch(undefined),
  RATE_LIMIT_WINDOW_MS: positiveInt.optional().catch(undefined),
});

class ConfigError extends Error {
  constructor(problems) {
    const listed = problems.map((problem) => `${problem.name} ${problem.reason}`).join("; ");
    super(`Cannot start: ${listed}. Copy server/.env.example to server/.env and fill it in.`);
    this.name = "ConfigError";
    // Name and reason only, so this can be printed as-is without leaking a value.
    this.problems = problems;
  }
}

function readEnv(env = process.env) {
  const parsed = schema.parse(env);
  const nodeEnv = parsed.NODE_ENV || "development";
  const isProduction = nodeEnv === "production";

  return {
    nodeEnv,
    isProduction,
    port: parsed.PORT,
    mongoUrl: parsed.MONGO_URL,
    clientOrigin: parsed.CLIENT_ORIGIN,
    jwt: {
      secret: parsed.JWT_SECRET,
      expiresIn: parsed.JWT_EXPIRES_IN,
      // A cookie without Secure travels over plain http, which a production deployment must never
      // do; a local dev server is http, so the default follows the deployment rather than a literal.
      cookieSecure: parsed.COOKIE_SECURE ?? isProduction,
    },
    admin: { email: parsed.ADMIN_EMAIL, password: parsed.ADMIN_PASSWORD },
    llm: {
      baseUrl: parsed.LLM_BASE_URL,
      model: parsed.LLM_MODEL,
      apiKey: parsed.LLM_API_KEY,
      timeoutMs: parsed.LLM_TIMEOUT_MS,
    },
    rateLimit: { max: parsed.RATE_LIMIT_MAX, windowMs: parsed.RATE_LIMIT_WINDOW_MS },
  };
}

// What the server cannot start without. Both are deployment facts with no safe default: a silent
// `mongodb://127.0.0.1` in production writes to the wrong database, and a silent empty JWT secret
// signs tokens anyone can forge.
function bootProblems(env = process.env) {
  const config = readEnv(env);
  const problems = [];

  if (!String(env.MONGO_URL ?? "").trim()) {
    problems.push({ name: "MONGO_URL", reason: "is not set" });
  }
  if (!config.jwt.secret) {
    problems.push({ name: "JWT_SECRET", reason: "is not set" });
  } else if (config.jwt.secret.length < MIN_JWT_SECRET_LENGTH) {
    problems.push({
      name: "JWT_SECRET",
      reason: `is shorter than ${MIN_JWT_SECRET_LENGTH} characters`,
    });
  }

  return { config, problems };
}

function assertBootable(env = process.env) {
  const { config, problems } = bootProblems(env);
  if (problems.length) throw new ConfigError(problems);
  return config;
}

module.exports = {
  readEnv,
  bootProblems,
  assertBootable,
  ConfigError,
  MIN_JWT_SECRET_LENGTH,
  DEFAULT_PORT,
  DEFAULT_MONGO_URL,
  DEFAULT_CLIENT_ORIGIN,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_JWT_EXPIRES_IN,
};
