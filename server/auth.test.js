const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const { createRouter } = require("./routes");
const { toHttpError } = require("./middleware/error");
const { requireRole } = require("./middleware/auth");
const { loadSession } = require("./engine/session");
const { User, userInputSchema } = require("./models/user");

const config = {
  jwt: { secret: "a".repeat(48), expiresIn: "7d", cookieSecure: false, cookieSameSite: "lax" },
};

test("user input and mongoose schema enforce the public account shape", () => {
  const parsed = userInputSchema.parse({ name: " Ada ", email: "ADA@EXAMPLE.COM", password: "password123" });
  assert.deepEqual(parsed, { name: "Ada", email: "ada@example.com", password: "password123" });
  assert.equal(User.schema.path("role").defaultValue, "student");
  assert.deepEqual(User.schema.path("role").enumValues, ["student", "admin"]);
  assert.equal(User.schema.path("email").options.unique, true);
  assert.equal(User.schema.path("passwordHash").options.select, false);
});

async function setup() {
  const users = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const header = req.headers.cookie || "";
    req.cookies = Object.fromEntries(
      header
        .split(";")
        .filter(Boolean)
        .map((part) => part.trim().split("="))
        .map(([key, ...value]) => [key, decodeURIComponent(value.join("="))])
    );
    next();
  });
  app.use(
    createRouter({
      config,
      findUserByEmail: async (email) => users.find((user) => user.email === email) || null,
      findUserById: async (id) => users.find((user) => String(user._id) === String(id)) || null,
      createUser: async (doc) => {
        const user = { _id: String(users.length + 1), createdAt: new Date(), ...doc };
        users.push(user);
        return user;
      },
    })
  );
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const { status, body } = toHttpError(error);
    res.status(status).json(body);
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, headers = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { users, call, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("register creates a student, lowercases email, and sets a local httpOnly lax cookie", async () => {
  const harness = await setup();
  try {
    const response = await harness.call("POST", "/auth/register", {
      name: "Ada",
      email: "ADA@EXAMPLE.COM",
      password: "correct horse battery staple",
      role: "admin",
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.user.email, "ada@example.com");
    assert.equal(body.user.role, "student");
    assert.equal(body.user.passwordHash, undefined);
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.doesNotMatch(cookie, /Secure/i);
  } finally {
    await harness.close();
  }
});

test("wrong credentials are generic and repeated failures receive Retry-After", async () => {
  const harness = await setup();
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await harness.call("POST", "/auth/login", {
        email: "missing@example.com",
        password: "wrong password",
      });
      assert.equal(response.status, 401);
      assert.deepEqual((await response.json()).message, "Invalid email or password.");
    }
    const limited = await harness.call("POST", "/auth/login", {
      email: "missing@example.com",
      password: "wrong password",
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  } finally {
    await harness.close();
  }
});

test("role middleware rejects students", async () => {
  const app = express();
  app.get("/admin", (req, res, next) => {
    req.user = { role: "student" };
    next();
  }, requireRole("admin"), (req, res) => res.sendStatus(204));
  app.use((error, req, res, next) => {
    if (error) return res.status(error.status).json({ error: error.code });
    return next();
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/admin`)).status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("session lookup filters by owner while admins can read any session", async () => {
  const session = { _id: "507f1f77bcf86cd799439011", userId: "student-1", packId: "missing", topic: "x" };
  const deps = {
    bundledPacks: () => [],
    findStored: async () => ({ pack: { packId: "missing", topic: "x", status: "curated", concepts: [], diagnostic: [], check: [], traces: {}, sources: [] } }),
    findSession: async (id, owner) => (owner === "student-1" ? session : owner === "admin-1" ? session : null),
  };
  await assert.rejects(loadSession({ sessionId: String(session._id), userId: "student-2", deps }));
  const loaded = await loadSession({ sessionId: String(session._id), userId: "admin-1", isAdmin: true, deps });
  assert.equal(loaded.session, session);
});
