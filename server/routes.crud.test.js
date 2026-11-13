// Phase R2: the CRUD and listing routes, over real HTTP with a fake store.
//
// What these tests are about: who may see which rows, what a list envelope says, which failure is
// which status code, and the one engine rule that shapes the admin surface — only an admin's
// approve may turn a generated pack into a curated one.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { makePack, makeFakeChat } = require("./engine/fixtures");
const { validatePack } = require("./packs/loader");
const { startRouter, tokenFor } = require("./routes.harness");

// --- fixtures -------------------------------------------------------------

function makeUser(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    name: "Student One",
    email: "one@example.test",
    // Present on purpose: a store that forgets `select: false` must still not leak it.
    passwordHash: "$2b$12$not-a-real-hash",
    role: "student",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeSessionDoc(user, pack, overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    userId: user._id,
    title: pack.topic,
    topic: pack.topic,
    packId: pack.packId,
    packStatus: pack.status,
    goal: "exam",
    answeredQuestionIds: [],
    skippedDiagnosis: false,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

let packDocClock = 0;

function makePackDoc(pack, overrides = {}) {
  // Each stored pack is created a second after the last, so "newest first" is a real order instead of
  // whatever the sort does with equal timestamps.
  packDocClock += 1;
  return {
    _id: new mongoose.Types.ObjectId(),
    topicKey: String(pack.topic).trim().toLowerCase(),
    topic: pack.topic,
    pack,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 3, 0, 0, packDocClock)),
    ...overrides,
  };
}

// --- a store with the production dep signatures ---------------------------

const sameId = (left, right) => String(left) === String(right);

function sessionMatches(doc, { userId, topic, q }) {
  if (userId !== undefined && !sameId(doc.userId, userId)) return false;
  if (topic && String(doc.topic).toLowerCase() !== String(topic).toLowerCase()) return false;
  if (q && !String(doc.title || "").toLowerCase().includes(String(q).toLowerCase())) return false;
  return true;
}

function packMatches(doc, { q, status }) {
  if (status && (doc.pack?.status ?? "generated") !== status) return false;
  if (q && !String(doc.topic).toLowerCase().includes(String(q).toLowerCase())) return false;
  return true;
}

function userMatches(doc, { q, role }) {
  if (role && doc.role !== role) return false;
  if (q) {
    const needle = String(q).toLowerCase();
    const haystack = `${doc.name} ${doc.email}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

const newestFirst = (left, right) => new Date(right.createdAt) - new Date(left.createdAt);

function storeDeps(store) {
  const { sessions, packs, users, events, bundled } = store;
  const chat = makeFakeChat();
  return {
    bundledPacks: () => bundled,
    findStored: async (topicKey) => packs.find((doc) => doc.topicKey === topicKey) || null,
    listStored: async () => packs,

    // The study routes reach this store too: /topics reads stored packs, /session creates one of the
    // rows this file lists, and /check and /plan read and write its evidence. Supplying them here
    // keeps every R2 test off real Mongoose and the real model.
    createSession: async (doc) => {
      const created = {
        _id: new mongoose.Types.ObjectId(),
        createdAt: new Date(),
        answeredQuestionIds: [],
        ...doc,
      };
      sessions.push(created);
      return created;
    },
    claim: async (sessionId, change) => {
      const doc = sessions.find((entry) => sameId(entry._id, sessionId));
      const questionId = change.$addToSet.answeredQuestionIds;
      if (!doc || doc.answeredQuestionIds.includes(questionId)) return null;
      doc.answeredQuestionIds.push(questionId);
      if (change.$set) Object.assign(doc, change.$set);
      return doc;
    },
    release: async (sessionId, change) => {
      const doc = sessions.find((entry) => sameId(entry._id, sessionId));
      const questionId = change.$pull.answeredQuestionIds;
      if (doc) doc.answeredQuestionIds = doc.answeredQuestionIds.filter((id) => id !== questionId);
    },
    findEvents: async (sessionId) => events.filter((event) => sameId(event.sessionId, sessionId)),
    countEvents: async (sessionId) =>
      events.filter((event) => sameId(event.sessionId, sessionId)).length,
    insertEvents: async (documents) => {
      events.push(...documents);
      return documents;
    },
    chatJson: chat.fn,

    findSession: async (sessionId, owner) => {
      const doc = sessions.find((session) => sameId(session._id, sessionId));
      if (!doc) return null;
      if (owner && !sameId(doc.userId, owner)) return null;
      return doc;
    },
    listSessions: async (query) =>
      sessions
        .filter((doc) => sessionMatches(doc, query))
        .sort(newestFirst)
        .slice(query.skip, query.skip + query.limit),
    countSessions: async (query) => sessions.filter((doc) => sessionMatches(doc, query)).length,
    updateSession: async (sessionId, change) => {
      const doc = sessions.find((session) => sameId(session._id, sessionId));
      if (!doc) return null;
      Object.assign(doc, change);
      return doc;
    },
    deleteSession: async (sessionId) => {
      const at = sessions.findIndex((session) => sameId(session._id, sessionId));
      if (at >= 0) sessions.splice(at, 1);
    },
    deleteSessionEvents: async (sessionId) => {
      let removed = 0;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (sameId(events[index].sessionId, sessionId)) {
          events.splice(index, 1);
          removed += 1;
        }
      }
      return removed;
    },

    listPacks: async (query) =>
      packs
        .filter((doc) => packMatches(doc, query))
        .sort(newestFirst)
        .slice(query.skip, query.skip + query.limit),
    countPacks: async (query) => packs.filter((doc) => packMatches(doc, query)).length,
    findPackById: async (packId) => packs.find((doc) => sameId(doc._id, packId)) || null,
    findPackByKey: async (topicKey) => packs.find((doc) => doc.topicKey === topicKey) || null,
    insertPack: async (doc) => {
      const created = { _id: new mongoose.Types.ObjectId(), createdAt: new Date(), ...doc };
      packs.push(created);
      return created;
    },
    updatePack: async (packId, change) => {
      const doc = packs.find((entry) => sameId(entry._id, packId));
      if (!doc) return null;
      Object.assign(doc, change);
      return doc;
    },
    deletePack: async (packId) => {
      const at = packs.findIndex((doc) => sameId(doc._id, packId));
      if (at >= 0) packs.splice(at, 1);
    },

    listUsers: async (query) =>
      users
        .filter((doc) => userMatches(doc, query))
        .sort(newestFirst)
        .slice(query.skip, query.skip + query.limit),
    countUsers: async (query) => users.filter((doc) => userMatches(doc, query)).length,
    findUserById: async (userId) => users.find((user) => sameId(user._id, userId)) || null,
    updateUserRole: async (userId, role) => {
      const doc = users.find((user) => sameId(user._id, userId));
      if (!doc) return null;
      doc.role = role;
      return doc;
    },
  };
}

async function setup({ bundled = [], packs = [], events = [] } = {}) {
  const one = makeUser();
  const two = makeUser({ name: "Student Two", email: "two@example.test" });
  const admin = makeUser({ name: "Admin Person", email: "admin@example.test", role: "admin" });
  const users = [one, two, admin];
  const store = { bundled, packs, events, users, sessions: [] };
  const harness = await startRouter(storeDeps(store));

  return {
    ...harness,
    store,
    student: one,
    otherStudent: two,
    admin,
    asStudent: tokenFor({ sub: one._id, role: "student", email: one.email }),
    asOther: tokenFor({ sub: two._id, role: "student", email: two.email }),
    asAdmin: tokenFor({ sub: admin._id, role: "admin", email: admin.email }),
  };
}

// --- GET /sessions --------------------------------------------------------

test("a session list needs a caller: no cookie is a 401", async () => {
  const app = await setup();
  try {
    const { status, body } = await app.get("/sessions");
    assert.equal(status, 401);
    assert.equal(body.error, "unauthorized");
  } finally {
    await app.close();
  }
});

test("the list holds the caller's own sessions, newest first, in one envelope", async () => {
  const pack = makePack();
  const app = await setup({ bundled: [pack] });
  try {
    app.store.sessions.push(
      makeSessionDoc(app.student, pack, {
        title: "Older",
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      }),
      makeSessionDoc(app.student, pack, {
        title: "Newer",
        createdAt: new Date("2026-02-02T00:00:00.000Z"),
      }),
      makeSessionDoc(app.otherStudent, pack, { title: "Not mine" })
    );

    const { status, body } = await app.get("/sessions", { token: app.asStudent });
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ["items", "limit", "page", "total", "totalPages"]);
    assert.deepEqual(body.items.map((item) => item.title), ["Newer", "Older"]);
    assert.equal(body.page, 1);
    assert.equal(body.limit, 20);
    assert.equal(body.total, 2);
    assert.equal(body.totalPages, 1);
    assert.equal(body.items[0].topic, pack.topic);
    assert.equal(body.items[0].packStatus, pack.status);
    // Ownership is the filter, not something the client is told about.
    assert.equal(body.items[0].userId, undefined);
  } finally {
    await app.close();
  }
});

test("the second page carries the rest and the same total", async () => {
  const pack = makePack();
  const app = await setup({ bundled: [pack] });
  try {
    for (const day of [1, 2, 3]) {
      app.store.sessions.push(
        makeSessionDoc(app.student, pack, {
          title: `Session ${day}`,
          createdAt: new Date(`2026-03-0${day}T00:00:00.000Z`),
        })
      );
    }

    const { body } = await app.get("/sessions?page=2&limit=2", { token: app.asStudent });
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].title, "Session 1");
    assert.equal(body.page, 2);
    assert.equal(body.total, 3);
    assert.equal(body.totalPages, 2);
  } finally {
    await app.close();
  }
});

test("an empty query value is no filter, and an oversized limit is refused", async () => {
  const pack = makePack();
  const app = await setup({ bundled: [pack] });
  try {
    app.store.sessions.push(
      makeSessionDoc(app.student, pack, { title: "First" }),
      makeSessionDoc(app.student, pack, { title: "Second" })
    );

    const empty = await app.get("/sessions?q=&topic=&page=&limit=", { token: app.asStudent });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.total, 2, "an empty field means unset, not match nothing");

    const capped = await app.get("/sessions?limit=51", { token: app.asStudent });
    assert.equal(capped.status, 400);
    assert.equal(capped.body.error, "invalid_request");
    assert.match(capped.body.message, /50/, "the refusal says what the cap is");
  } finally {
    await app.close();
  }
});

test("the list filters by topic and searches the title", async () => {
  const pack = makePack();
  const other = makePack({ topic: "Another Topic", packId: "sample-2" });
  const app = await setup({ bundled: [pack, other] });
  try {
    app.store.sessions.push(
      makeSessionDoc(app.student, pack, { title: "Recursion practice" }),
      makeSessionDoc(app.student, other, { title: "Loops practice" }),
      makeSessionDoc(app.student, pack, { title: "Reading list" })
    );

    const byTopic = await app.get(`/sessions?topic=${encodeURIComponent(pack.topic)}`, {
      token: app.asStudent,
    });
    assert.equal(byTopic.body.total, 2);

    const byTitle = await app.get("/sessions?q=loops", { token: app.asStudent });
    assert.equal(byTitle.body.total, 1);
    assert.equal(byTitle.body.items[0].title, "Loops practice");

    // A search is text, never a pattern: `.` must not match any character.
    const literal = await app.get("/sessions?q=%2E", { token: app.asStudent });
    assert.equal(literal.status, 200);
  } finally {
    await app.close();
  }
});

test("a session created before titles existed is listed under its topic", async () => {
  const pack = makePack();
  const app = await setup({ bundled: [pack] });
  try {
    app.store.sessions.push(makeSessionDoc(app.student, pack, { title: "" }));
    const { body } = await app.get("/sessions", { token: app.asStudent });
    assert.equal(body.items[0].title, pack.topic);
  } finally {
    await app.close();
  }
});

// --- GET /sessions/:id, PATCH, DELETE ------------------------------------

test("one session is readable by its owner, with its progress", async () => {
  const pack = makePack();
  const app = await setup({ bundled: [pack] });
  try {
    const session = makeSessionDoc(app.student, pack, {
      title: "My notes on parts",
      answeredQuestionIds: ["d1", "d2"],
    });
    app.store.sessions.push(session);

    const { status, body } = await app.get(`/sessions/${session._id}`, { token: app.asStudent });
    assert.equal(status, 200);
    assert.equal(body.session.id, String(session._id));
    assert.equal(body.session.title, "My notes on parts");
    assert.equal(body.session.answeredCount, 2);
    assert.equal(body.session.userId, undefined);
  } finally {
    await app.close();
  }
});

test("another student's session is not found, and neither renamed nor deleted", async () => {
  const pack = makePack();
  const app = await setup({ bundled: [pack] });
  try {
    const session = makeSessionDoc(app.otherStudent, pack, { title: "Theirs" });
    app.store.sessions.push(session);
    app.store.events.push({ sessionId: session._id, conceptId: "part_1", outcome: "correct" });

    const read = await app.get(`/sessions/${session._id}`, { token: app.asStudent });
    assert.equal(read.status, 404);
    assert.equal(read.body.error, "session_not_found");

    const renamed = await app.patch(
      `/sessions/${session._id}`,
      { title: "Hijacked" },
      { token: app.asStudent }
    );
    assert.equal(renamed.status, 404);

    const removed = await app.delete(`/sessions/${session._id}`, { token: app.asStudent });
    assert.equal(removed.status, 404);

    assert.equal(app.store.sessions[0].title, "Theirs");
    assert.equal(app.store.events.length, 1, "nothing was deleted");
  } finally {
    await app.close();
  }
});

test("a title can be changed, and an empty or oversized one is refused", async () => {
  const pack = makePack();
  const app = await setup({ bundled: [pack] });
  try {
    const session = makeSessionDoc(app.student, pack);
    app.store.sessions.push(session);

    const renamed = await app.patch(
      `/sessions/${session._id}`,
      { title: "  Before the exam  " },
      { token: app.asStudent }
    );
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.session.title, "Before the exam", "stored trimmed");

    const empty = await app.patch(`/sessions/${session._id}`, { title: "   " }, { token: app.asStudent });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, "invalid_request");

    const tooLong = await app.patch(
      `/sessions/${session._id}`,
      { title: "x".repeat(121) },
      { token: app.asStudent }
    );
    assert.equal(tooLong.status, 400);
    assert.equal(app.store.sessions[0].title, "Before the exam", "a refused rename changes nothing");
  } finally {
    await app.close();
  }
});

test("deleting a session deletes its evidence and nothing else", async () => {
  const pack = makePack();
  const app = await setup({ bundled: [pack] });
  try {
    const doomed = makeSessionDoc(app.student, pack, { title: "Doomed" });
    const kept = makeSessionDoc(app.student, pack, { title: "Kept" });
    app.store.sessions.push(doomed, kept);
    app.store.events.push(
      { sessionId: doomed._id, conceptId: "part_1", outcome: "correct" },
      { sessionId: doomed._id, conceptId: "part_2", outcome: "incorrect" },
      { sessionId: kept._id, conceptId: "part_1", outcome: "correct" }
    );

    const { status, body } = await app.delete(`/sessions/${doomed._id}`, { token: app.asStudent });
    assert.equal(status, 204);
    assert.equal(body, null);

    assert.equal(app.store.sessions.length, 1);
    assert.equal(app.store.sessions[0].title, "Kept");
    assert.equal(app.store.events.length, 1, "only the deleted session's evidence went");
    assert.equal(String(app.store.events[0].sessionId), String(kept._id));
  } finally {
    await app.close();
  }
});

// --- /admin/packs ---------------------------------------------------------

test("every admin pack route refuses a student and an anonymous caller", async () => {
  const app = await setup();
  try {
    const packDoc = makePackDoc(makePack({ status: "generated" }));
    app.store.packs.push(packDoc);
    const routes = [
      ["GET", "/admin/packs"],
      ["GET", `/admin/packs/${packDoc._id}`],
      ["POST", "/admin/packs"],
      ["PUT", `/admin/packs/${packDoc._id}`],
      ["POST", `/admin/packs/${packDoc._id}/approve`],
      ["DELETE", `/admin/packs/${packDoc._id}`],
    ];

    // A body is only sent where the route reads one; the harness takes it positionally.
    const send = (method, path, options) =>
      method === "GET" || method === "DELETE"
        ? app[method.toLowerCase()](path, options)
        : app[method.toLowerCase()](path, {}, options);

    for (const [method, path] of routes) {
      const anonymous = await send(method, path, {});
      assert.equal(anonymous.status, 401, `${method} ${path} without a cookie`);

      const asStudent = await send(method, path, { token: app.asStudent });
      assert.equal(asStudent.status, 403, `${method} ${path} as a student`);
      assert.equal(asStudent.body.error, "forbidden");
    }
  } finally {
    await app.close();
  }
});

test("the pack list reports each stored pack's review state", async () => {
  const app = await setup();
  try {
    app.store.packs.push(
      makePackDoc(makePack({ status: "generated" }), {
        reviewedBy: "admin@example.test",
        reviewedAt: new Date("2026-04-01T00:00:00.000Z"),
      }),
      makePackDoc(makePack({ topic: "Second Topic", packId: "sample-2" }))
    );

    const { status, body } = await app.get("/admin/packs", { token: app.asAdmin });
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ["items", "limit", "page", "total", "totalPages"]);
    assert.equal(body.total, 2);
    assert.equal(body.items[0].topic, "Second Topic", "newest first");
    assert.equal(body.items[1].reviewedBy, "admin@example.test");
    assert.equal(body.items[1].conceptCount, 8);
    assert.equal(body.items[1].questionCount, 8);
    // A listing is a summary; the answer keys stay behind the detail route.
    assert.equal(body.items[1].pack, undefined);
  } finally {
    await app.close();
  }
});

test("the pack list filters by status and searches the topic", async () => {
  const app = await setup();
  try {
    app.store.packs.push(
      makePackDoc(makePack({ status: "generated" })),
      makePackDoc(makePack({ topic: "Approved Topic", packId: "sample-2", status: "curated" }))
    );

    const curated = await app.get("/admin/packs?status=curated", { token: app.asAdmin });
    assert.equal(curated.body.total, 1);
    assert.equal(curated.body.items[0].status, "curated");

    const searched = await app.get("/admin/packs?q=approved", { token: app.asAdmin });
    assert.equal(searched.body.total, 1);

    const refused = await app.get("/admin/packs?status=draft", { token: app.asAdmin });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "invalid_request");
  } finally {
    await app.close();
  }
});

test("one pack returns its whole JSON, keys included, because approval is key review", async () => {
  const pack = makePack({ status: "generated" });
  const app = await setup();
  try {
    const doc = makePackDoc(pack);
    app.store.packs.push(doc);

    const { status, body } = await app.get(`/admin/packs/${doc._id}`, { token: app.asAdmin });
    assert.equal(status, 200);
    assert.equal(body.pack.id, String(doc._id));
    assert.equal(body.pack.status, "generated");
    assert.equal(body.pack.pack.packId, pack.packId);
    assert.equal(body.pack.pack.check[0].answerKey.value, "option b");
  } finally {
    await app.close();
  }
});

test("an unknown pack id is a 404 on every route that addresses one", async () => {
  const app = await setup();
  try {
    const missing = new mongoose.Types.ObjectId();
    for (const [method, path] of [
      ["GET", `/admin/packs/${missing}`],
      ["PUT", `/admin/packs/${missing}`],
      ["POST", `/admin/packs/${missing}/approve`],
      ["DELETE", `/admin/packs/${missing}`],
    ]) {
      const response =
        method === "GET" || method === "DELETE"
          ? await app[method.toLowerCase()](path, { token: app.asAdmin })
          : await app[method.toLowerCase()](path, makePack(), { token: app.asAdmin });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.equal(response.body.error, "pack_not_found");
    }
  } finally {
    await app.close();
  }
});

test("an imported pack is stored as a draft even when the body claims to be curated", async () => {
  const app = await setup();
  try {
    const claimed = makePack({ status: "curated" });
    const { status, body } = await app.post("/admin/packs", claimed, { token: app.asAdmin });

    assert.equal(status, 201);
    assert.equal(body.pack.status, "generated", "an import cannot approve itself");
    assert.equal(body.pack.reviewedBy, null);
    assert.equal(app.store.packs.length, 1);
    assert.equal(app.store.packs[0].topicKey, "sample topic");
    assert.equal(app.store.packs[0].pack.status, "generated");
  } finally {
    await app.close();
  }
});

test("an invalid pack is refused with the validator's reasons and nothing is stored", async () => {
  const app = await setup();
  try {
    const broken = makePack({ status: "generated" });
    broken.check[0].answerKey = { type: "option", value: "option z" };

    const { status, body } = await app.post("/admin/packs", broken, { token: app.asAdmin });
    assert.equal(status, 422);
    assert.equal(body.error, "pack_invalid");
    assert.ok(Array.isArray(body.errors) && body.errors.length > 0);
    assert.match(body.errors.join(" "), /option z/);
    assert.equal(app.store.packs.length, 0);
  } finally {
    await app.close();
  }
});

test("a body with no pack in it is refused, not stored empty", async () => {
  const app = await setup();
  try {
    const { status, body } = await app.post("/admin/packs", { title: "not a pack" }, { token: app.asAdmin });
    assert.equal(status, 422);
    assert.equal(body.error, "pack_invalid");
    assert.equal(app.store.packs.length, 0);
  } finally {
    await app.close();
  }
});

test("importing a topic that already has a stored pack is a conflict", async () => {
  const app = await setup();
  try {
    app.store.packs.push(makePackDoc(makePack({ status: "generated" })));
    const { status, body } = await app.post("/admin/packs", makePack(), { token: app.asAdmin });
    assert.equal(status, 409);
    assert.equal(body.error, "pack_exists");
    assert.equal(app.store.packs.length, 1);
  } finally {
    await app.close();
  }
});

test("importing a pack whose id a bundled pack already uses is a conflict", async () => {
  const bundled = makePack({ topic: "Bundled Topic", packId: "sample-1" });
  const app = await setup({ bundled: [bundled] });
  try {
    const { status, body } = await app.post(
      "/admin/packs",
      makePack({ topic: "Other Topic", packId: "sample-1" }),
      { token: app.asAdmin }
    );
    assert.equal(status, 409);
    assert.equal(body.error, "pack_exists");
  } finally {
    await app.close();
  }
});

test("an edit is re-validated and revokes an earlier approval", async () => {
  const pack = makePack({ status: "curated" });
  const app = await setup();
  try {
    const doc = makePackDoc(pack, {
      reviewedBy: "admin@example.test",
      reviewedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    app.store.packs.push(doc);

    const edited = { ...makePack({ status: "generated" }), topic: "Renamed Topic", version: "1.0.1" };
    const { status, body } = await app.put(`/admin/packs/${doc._id}`, edited, { token: app.asAdmin });
    assert.equal(status, 200);
    assert.equal(body.pack.topic, "Renamed Topic");
    assert.equal(body.pack.status, "generated", "the reviewed bytes are gone, so the approval is");
    assert.equal(body.pack.reviewedBy, null);
    assert.equal(body.pack.reviewedAt, null);
    assert.equal(app.store.packs[0].topicKey, "renamed topic");

    const broken = { ...edited };
    broken.concepts = [];
    const refused = await app.put(`/admin/packs/${doc._id}`, broken, { token: app.asAdmin });
    assert.equal(refused.status, 422);
    assert.equal(app.store.packs[0].topic, "Renamed Topic", "a refused edit changes nothing");
  } finally {
    await app.close();
  }
});

test("an edit cannot change a pack's id under the sessions running on it", async () => {
  const app = await setup();
  try {
    const doc = makePackDoc(makePack({ status: "generated" }));
    app.store.packs.push(doc);
    const otherId = { ...makePack(), packId: "different-pack" };

    const { status, body } = await app.put(`/admin/packs/${doc._id}`, otherId, { token: app.asAdmin });
    assert.equal(status, 422);
    assert.equal(body.error, "pack_invalid");
    assert.equal(app.store.packs[0].pack.packId, "sample-1");
  } finally {
    await app.close();
  }
});

test("approval is the only thing that makes a pack curated, and it records who and when", async () => {
  const app = await setup();
  try {
    const doc = makePackDoc(makePack({ status: "generated" }));
    app.store.packs.push(doc);

    const { status, body } = await app.post(`/admin/packs/${doc._id}/approve`, undefined, {
      token: app.asAdmin,
    });
    assert.equal(status, 200);
    assert.equal(body.pack.status, "curated");
    assert.equal(body.pack.reviewedBy, "admin@example.test");
    assert.ok(body.pack.reviewedAt, "the time of the review is recorded");

    const stored = app.store.packs[0];
    assert.equal(stored.pack.status, "curated");
    assert.equal(validatePack(stored.pack).valid, true, "an approved pack is always serveable");

    const topics = await app.get("/topics");
    assert.deepEqual(
      topics.body.topics.map((entry) => [entry.topic, entry.source, entry.reviewed]),
      [["Sample Topic", "curated", true]],
      "an approved pack is offered as curated, because a human checked every key"
    );
  } finally {
    await app.close();
  }
});

test("approval refuses a stored pack that no longer validates", async () => {
  const app = await setup();
  try {
    const broken = makePack({ status: "generated" });
    broken.diagnostic[0].answerKey = { type: "option", value: "option z" };
    const doc = makePackDoc(broken);
    app.store.packs.push(doc);

    const { status, body } = await app.post(`/admin/packs/${doc._id}/approve`, undefined, {
      token: app.asAdmin,
    });
    assert.equal(status, 422);
    assert.equal(body.error, "pack_invalid");
    assert.equal(app.store.packs[0].pack.status, "generated", "nothing was blessed");
    assert.equal(app.store.packs[0].reviewedBy, null);
  } finally {
    await app.close();
  }
});

test("a pack can be deleted, and the deletion removes only that record", async () => {
  const app = await setup();
  try {
    const doomed = makePackDoc(makePack({ status: "generated" }));
    const kept = makePackDoc(makePack({ topic: "Kept Topic", packId: "sample-2" }));
    app.store.packs.push(doomed, kept);

    const { status } = await app.delete(`/admin/packs/${doomed._id}`, { token: app.asAdmin });
    assert.equal(status, 204);
    assert.equal(app.store.packs.length, 1);
    assert.equal(app.store.packs[0].topic, "Kept Topic");
  } finally {
    await app.close();
  }
});

// --- /admin/users ---------------------------------------------------------

test("the user list carries no password material, even from a store that returns it", async () => {
  const app = await setup();
  try {
    const { status, body } = await app.get("/admin/users", { token: app.asAdmin });
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ["items", "limit", "page", "total", "totalPages"]);
    assert.equal(body.total, 3);
    assert.deepEqual(Object.keys(body.items[0]).sort(), ["createdAt", "email", "id", "name", "role"]);
    assert.doesNotMatch(JSON.stringify(body), /password/i);
  } finally {
    await app.close();
  }
});

test("the user list filters by role and searches name or email", async () => {
  const app = await setup();
  try {
    const admins = await app.get("/admin/users?role=admin", { token: app.asAdmin });
    assert.equal(admins.body.total, 1);
    assert.equal(admins.body.items[0].email, "admin@example.test");

    const byName = await app.get("/admin/users?q=student+two", { token: app.asAdmin });
    assert.equal(byName.body.total, 1);
    assert.equal(byName.body.items[0].name, "Student Two");

    const byEmail = await app.get("/admin/users?q=two%40example", { token: app.asAdmin });
    assert.equal(byEmail.body.total, 1);

    const badRole = await app.get("/admin/users?role=teacher", { token: app.asAdmin });
    assert.equal(badRole.status, 400);
  } finally {
    await app.close();
  }
});

test("a role can be changed, and an unknown user is a 404", async () => {
  const app = await setup();
  try {
    const promoted = await app.patch(
      `/admin/users/${app.otherStudent._id}/role`,
      { role: "admin" },
      { token: app.asAdmin }
    );
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.user.role, "admin");
    assert.equal(app.store.users[1].role, "admin");

    const missing = await app.patch(
      `/admin/users/${new mongoose.Types.ObjectId()}/role`,
      { role: "student" },
      { token: app.asAdmin }
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "user_not_found");
  } finally {
    await app.close();
  }
});

test("an admin cannot change their own role, and a role that is not one of the two is refused", async () => {
  const app = await setup();
  try {
    const self = await app.patch(
      `/admin/users/${app.admin._id}/role`,
      { role: "student" },
      { token: app.asAdmin }
    );
    assert.equal(self.status, 400);
    assert.equal(self.body.error, "cannot_change_own_role");
    assert.equal(app.store.users[2].role, "admin");

    const invented = await app.patch(
      `/admin/users/${app.otherStudent._id}/role`,
      { role: "teacher" },
      { token: app.asAdmin }
    );
    assert.equal(invented.status, 400);
    assert.equal(invented.body.error, "invalid_request");
  } finally {
    await app.close();
  }
});

// --- provenance -----------------------------------------------------------

// A4 hangs off the pack a session STARTED on. An admin approving a stored pack while a session is
// running on it must not rewrite what the evidence already recorded: the key that graded the
// student's answer was the model's, and stays the model's.
test("approving a pack does not upgrade evidence already recorded on it", async () => {
  const live = makePack({ status: "generated" });
  // Only the store holds the pack, because only a stored pack can be approved: a bundled file is
  // versioned with the code and has no approve route.
  const app = await setup();
  try {
    const doc = makePackDoc({ ...live, status: "generated" });
    app.store.packs.push(doc);
    const session = makeSessionDoc(app.student, { ...live, status: "generated" });
    app.store.sessions.push(session);

    // The pack is promoted between the two answers, which is the moment the provenance could move.
    const first = await app.post(
      "/check",
      { sessionId: String(session._id), questionId: "c1", answer: "option b" },
      { token: app.asStudent }
    );
    assert.equal(first.status, 200);
    app.store.packs[0].pack = { ...app.store.packs[0].pack, status: "curated" };

    const middle = await app.post(
      "/check",
      { sessionId: String(session._id), questionId: "c2", answer: "It names the idea.", why: "because it says what the idea does" },
      { token: app.asStudent }
    );
    assert.equal(middle.status, 200);

    const second = await app.post(
      "/check",
      { sessionId: String(session._id), questionId: "c3", answer: "option b" },
      { token: app.asStudent }
    );
    assert.equal(second.status, 200);

    assert.equal(app.store.events.length, 3);
    for (const event of app.store.events) {
      assert.equal(event.evidenceQuality, "llm_keyed", "the session's own pack status graded it");
    }

    const plan = await app.get(`/plan/${session._id}`, { token: app.asStudent });
    const finding = plan.body.findings.find((entry) => entry.conceptId === "part_1");
    assert.equal(finding.status, "demonstrated");
    assert.equal(finding.certainty, "likely demonstrated", "never 'demonstrated' on a draft's keys");
  } finally {
    await app.close();
  }
});

// --- a created session starts with a title -------------------------------

test("a new session is titled by its topic and can be renamed afterwards", async () => {
  const pack = makePack();
  const app = await setup({ bundled: [pack] });
  try {
    const created = await app.post("/session", { topic: pack.topic }, { token: app.asStudent });
    assert.equal(created.status, 201);

    const { body } = await app.get("/sessions", { token: app.asStudent });
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].title, pack.topic);

    const renamed = await app.patch(
      `/sessions/${created.body.sessionId}`,
      { title: "Renamed" },
      { token: app.asStudent }
    );
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.session.title, "Renamed");
  } finally {
    await app.close();
  }
});
