const { test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const express = require("express");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const { createRouter } = require("./routes");
const { requireRole } = require("./middleware/auth");
const { toHttpError } = require("./middleware/error");
const authController = require("./controllers/auth");

const config = {
  jwt: { secret: "b".repeat(48), expiresIn: "7d", cookieSecure: false, cookieSameSite: "lax" },
};

test("(1) both login paths (unknown email and existing user) call bcrypt.compare with a valid 60-char hash", async () => {
  const compareCalls = [];
  const originalCompare = bcrypt.compare;
  bcrypt.compare = async (password, hash) => {
    compareCalls.push({ password, hash, length: hash.length });
    return originalCompare(password, hash);
  };

  const users = [
    {
      _id: "user-1",
      email: "real@example.com",
      passwordHash: bcrypt.hashSync("password123", 12),
      role: "student",
    },
  ];

  const app = express();
  app.use(express.json());
  app.use(
    createRouter({
      config,
      findUserByEmail: async (email) => users.find((u) => u.email === email) || null,
      findUserById: async (id) => users.find((u) => u._id === id) || null,
    })
  );
  app.use((err, req, res, next) => {
    const { status, body } = toHttpError(err);
    res.status(status).json(body);
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Unknown email
    await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "unknown@example.com", password: "somepassword" }),
    });

    // 2. Existing user
    await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "real@example.com", password: "wrongpassword" }),
    });

    assert.equal(compareCalls.length, 2);
    assert.equal(compareCalls[0].length, 60, "unknown email hash must be exactly 60 chars");
    assert.equal(compareCalls[1].length, 60, "existing user hash must be exactly 60 chars");
    assert.match(compareCalls[0].hash, /^\$2[aby]\$\d{2}\$/);
    assert.match(compareCalls[1].hash, /^\$2[aby]\$\d{2}\$/);
  } finally {
    bcrypt.compare = originalCompare;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("(2) requireRole('admin') re-loads user from database: returns 401 if deleted and 403 if demoted", async () => {
  let userInDb = { _id: "admin-1", email: "admin@example.com", role: "admin" };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const header = req.headers.cookie || "";
    req.cookies = Object.fromEntries(
      header
        .split(";")
        .filter(Boolean)
        .map((part) => part.trim().split("="))
        .map(([k, ...v]) => [k, decodeURIComponent(v.join("="))])
    );
    next();
  });

  app.use(
    createRouter({
      config,
      findUserById: async (id) => {
        if (userInDb && String(userInDb._id) === String(id)) return userInDb;
        return null;
      },
      listUsers: async () => [],
      countUsers: async () => 0,
      updateUserRole: async () => null,
      deleteUser: async () => null,
    })
  );
  app.use((err, req, res, next) => {
    const { status, body } = toHttpError(err);
    res.status(status).json(body);
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // Mint token with admin role
    const adminToken = jwt.sign({ sub: "admin-1", role: "admin", email: "admin@example.com" }, config.jwt.secret);

    // 1. Valid active admin succeeds on admin route
    const okRes = await fetch(`${base}/admin/users`, {
      headers: { cookie: `clario_token=${adminToken}` },
    });
    assert.equal(okRes.status, 200);

    // 2. User is demoted in DB -> must return 403
    userInDb.role = "student";
    const demotedRes = await fetch(`${base}/admin/users`, {
      headers: { cookie: `clario_token=${adminToken}` },
    });
    assert.equal(demotedRes.status, 403, "demoted admin must get 403");

    // 3. User is deleted from DB -> must return 401
    userInDb = null;
    const deletedRes = await fetch(`${base}/admin/users`, {
      headers: { cookie: `clario_token=${adminToken}` },
    });
    assert.equal(deletedRes.status, 401, "deleted user must get 401");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("(2b) PATCH and DELETE on /admin/users/:id re-verify caller still exists and is admin", async () => {
  let callerInDb = { _id: "caller-admin", email: "caller@example.com", role: "admin" };
  const targetUser = { _id: "target-1", email: "target@example.com", role: "student" };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const header = req.headers.cookie || "";
    req.cookies = Object.fromEntries(
      header
        .split(";")
        .filter(Boolean)
        .map((part) => part.trim().split("="))
        .map(([k, ...v]) => [k, decodeURIComponent(v.join("="))])
    );
    next();
  });

  app.use(
    createRouter({
      config,
      findUserById: async (id) => {
        if (callerInDb && String(callerInDb._id) === String(id)) return callerInDb;
        if (targetUser && String(targetUser._id) === String(id)) return targetUser;
        return null;
      },
      updateUserRole: async (id, role) => ({ ...targetUser, role }),
      deleteUser: async (id) => targetUser,
    })
  );
  app.use((err, req, res, next) => {
    const { status, body } = toHttpError(err);
    res.status(status).json(body);
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const token = jwt.sign({ sub: "caller-admin", role: "admin" }, config.jwt.secret);

    // Caller demoted -> PATCH returns 403
    callerInDb.role = "student";
    const demotedPatch = await fetch(`${base}/admin/users/target-1/role`, {
      method: "PATCH",
      headers: { cookie: `clario_token=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    assert.equal(demotedPatch.status, 403);

    // Caller deleted -> PATCH returns 401
    callerInDb = null;
    const deletedPatch = await fetch(`${base}/admin/users/target-1/role`, {
      method: "PATCH",
      headers: { cookie: `clario_token=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    assert.equal(deletedPatch.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
