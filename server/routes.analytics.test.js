// Phase R5: the admin analytics overview, over real HTTP with fake store aggregates.
//
// The aggregation pipelines themselves live in routes/index.js next to the Mongoose wiring and need a
// live Mongo, which the CI does not have, so the fakes here replicate their shapes and their numbers on
// the in-memory store: same grouping, same UTC day buckets, same sort orders. If a pipeline in
// defaultDeps changes shape, these fakes must change with it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { makePack } = require("./engine/fixtures");
const { startRouter, tokenFor } = require("./routes.harness");

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function makeUser(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    name: "Student One",
    email: "one@example.test",
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
    createdAt: new Date(),
    ...overrides,
  };
}

function makeEventDoc(session, overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    sessionId: session._id,
    conceptId: "part_1",
    questionId: "d1",
    evidenceType: "demonstrated",
    gradedBy: "code",
    evidenceQuality: "code_keyed",
    outcome: "correct",
    note: "",
    createdAt: new Date(),
    ...overrides,
  };
}

const sameId = (left, right) => String(left) === String(right);
const daysAgo = (n, hour = 0) => {
  const date = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
};

function analyticsDeps(store) {
  const { sessions, events } = store;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  return {
    // UTC day grouping, like $dateToString: "UTC" in the pipeline.
    analyticsSessionsPerDay: async () => {
      const counts = new Map();
      for (const session of sessions) {
        const created = new Date(session.createdAt);
        if (created < since) continue;
        const day = isoDay(created);
        counts.set(day, (counts.get(day) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([_id, count]) => ({ _id, count }));
    },
    analyticsEvidenceByQuality: async () => {
      const counts = new Map();
      for (const event of events) {
        const key = event.evidenceQuality ?? null;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()].map(([_id, count]) => ({ _id, count }));
    },
    analyticsTopicsBySessions: async () => {
      const counts = new Map();
      for (const session of sessions) {
        const key = String(session.topic).toLowerCase();
        const entry = counts.get(key) ?? { topic: session.topic, sessions: 0 };
        entry.sessions += 1;
        counts.set(key, entry);
      }
      return [...counts.entries()]
        .map(([_id, entry]) => entry)
        .sort((left, right) => right.sessions - left.sessions || (left.topic < right.topic ? -1 : 1))
        .slice(0, 10);
    },
    analyticsOutcomeCounts: async (topic) => {
      const needle = String(topic).toLowerCase();
      const sessionIds = new Set(
        sessions.filter((session) => String(session.topic).toLowerCase() === needle).map((session) => String(session._id))
      );
      const counts = new Map();
      for (const event of events) {
        if (!sessionIds.has(String(event.sessionId))) continue;
        const key = `${event.conceptId}::${event.outcome}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()].map(([key, count]) => {
        const [conceptId, outcome] = key.split("::");
        return { _id: { conceptId, outcome }, count };
      });
    },
    analyticsDegradedRate: async () => ({ recorded: false, rate: null }),
  };
}

async function setup({ bundled = [], events = [] } = {}) {
  const pack = makePack();
  const student = makeUser();
  const admin = makeUser({ name: "Admin Person", email: "admin@example.test", role: "admin" });
  const store = { bundled, packs: [], events, users: [student, admin], sessions: [] };

  const harness = await startRouter({
    bundledPacks: () => bundled,
    listStored: async () => store.packs,
    findStored: async (topicKey) => store.packs.find((doc) => doc.topicKey === topicKey) || null,
    findSession: async (sessionId) =>
      store.sessions.find((session) => sameId(session._id, sessionId)) || null,
    findUserById: async (userId) => store.users.find((user) => sameId(user._id, userId)) || null,
    ...analyticsDeps(store),
  });

  return {
    ...harness,
    store,
    pack,
    student,
    admin,
    asStudent: tokenFor({ sub: student._id, role: "student", email: student.email }),
    asAdmin: tokenFor({ sub: admin._id, role: "admin", email: admin.email }),
  };
}

test("the analytics route needs admin: 401 anonymous, 403 student", async () => {
  const app = await setup();
  try {
    const anonymous = await app.get("/admin/analytics/overview");
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error, "unauthorized");

    const asStudent = await app.get("/admin/analytics/overview", { token: app.asStudent });
    assert.equal(asStudent.status, 403);
    assert.equal(asStudent.body.error, "forbidden");
  } finally {
    await app.close();
  }
});

test("an empty store reports 30 zero days, zeroed qualities, and no topics", async () => {
  const app = await setup({ bundled: [makePack()] });
  try {
    const { status, body } = await app.get("/admin/analytics/overview", { token: app.asAdmin });
    assert.equal(status, 200);
    assert.equal(body.sessionsPerDay.length, 30);
    assert.ok(body.sessionsPerDay.every((entry) => entry.count === 0));
    assert.deepEqual(body.evidenceByQuality, [
      { quality: "code_keyed", count: 0 },
      { quality: "llm_keyed", count: 0 },
      { quality: "llm_graded", count: 0 },
      { quality: "self_reported", count: 0 },
    ]);
    assert.deepEqual(body.topicsBySessions, []);
    assert.deepEqual(body.outcomesByConcept, {
      topic: null,
      topicSource: null,
      packAvailable: true,
      concepts: [],
    });
    assert.deepEqual(body.degradedRate, { recorded: false, rate: null });
  } finally {
    await app.close();
  }
});

test("sessions are grouped by UTC day, and days older than 30 days are excluded", async () => {
  const pack = makePack();
  const app = await setup({ bundled: [pack] });
  try {
    app.store.sessions.push(
      makeSessionDoc(app.student, pack, { createdAt: daysAgo(0, 10) }),
      makeSessionDoc(app.student, pack, { createdAt: daysAgo(0, 20) }),
      makeSessionDoc(app.student, pack, { createdAt: daysAgo(2) }),
      makeSessionDoc(app.student, pack, { createdAt: daysAgo(40) }),
    );

    const { body } = await app.get("/admin/analytics/overview", { token: app.asAdmin });
    const total = body.sessionsPerDay.reduce((sum, entry) => sum + entry.count, 0);
    assert.deepEqual(
      body.sessionsPerDay.map((entry) => [entry.date, entry.count]).slice(-3),
      [
        [isoDay(daysAgo(2)), 1],
        [isoDay(daysAgo(1)), 0],
        [isoDay(daysAgo(0)), 2],
      ]
    );
    assert.equal(total, 3);
  } finally {
    await app.close();
  }
});

test("evidence events are grouped by quality, self_report rows named", async () => {
  const pack = makePack();
  const session = makeSessionDoc(makeUser(), pack);
  const events = [
    { evidenceQuality: "code_keyed", outcome: "correct" },
    { evidenceQuality: "code_keyed", outcome: "incorrect" },
    { evidenceQuality: "llm_graded", outcome: "partial" },
    { evidenceQuality: null, outcome: "unsure", gradedBy: "student", evidenceType: "self_report" },
  ].map((event) => makeEventDoc(session, event));
  const app = await setup({ bundled: [pack], events });
  try {
    const { body } = await app.get("/admin/analytics/overview", { token: app.asAdmin });
    assert.deepEqual(body.evidenceByQuality, [
      { quality: "code_keyed", count: 2 },
      { quality: "llm_keyed", count: 0 },
      { quality: "llm_graded", count: 1 },
      { quality: "self_reported", count: 1 },
    ]);
  } finally {
    await app.close();
  }
});

test("topics are ranked by session count, and the outcomes table defaults to the top topic", async () => {
  const popular = makePack({ topic: "Popular Topic", packId: "popular-1" });
  const other = makePack({ topic: "Other Topic", packId: "other-1" });
  const app = await setup({ bundled: [popular, other] });
  try {
    for (let i = 0; i < 3; i += 1) app.store.sessions.push(makeSessionDoc(app.student, popular));
    app.store.sessions.push(makeSessionDoc(app.student, other));

    const { status, body } = await app.get("/admin/analytics/overview", { token: app.asAdmin });
    assert.equal(status, 200);
    assert.deepEqual(body.topicsBySessions, [
      { topic: "Popular Topic", sessions: 3 },
      { topic: "Other Topic", sessions: 1 },
    ]);
    assert.equal(body.outcomesByConcept.topic, "Popular Topic");
    assert.equal(body.outcomesByConcept.topicSource, "most_sessions");
    assert.equal(body.outcomesByConcept.concepts.length, 8); // every concept, including unassessed
  } finally {
    await app.close();
  }
});

test("outcomes bucket concepts as mastered, struggling, emerging and unassessed", async () => {
  const pack = makePack();
  const app = await setup({ bundled: [pack] });
  try {
    const session = makeSessionDoc(app.student, pack);
    app.store.sessions.push(session);
    // part_1: two correct → mastered. part_2: one correct vs two incorrect → struggling.
    // part_3: one correct only → emerging. part_4 onward: unassessed.
    app.store.events.push(
      makeEventDoc(session, { conceptId: "part_1", outcome: "correct" }),
      makeEventDoc(session, { conceptId: "part_1", outcome: "correct" }),
      makeEventDoc(session, { conceptId: "part_2", outcome: "correct" }),
      makeEventDoc(session, { conceptId: "part_2", outcome: "incorrect" }),
      makeEventDoc(session, { conceptId: "part_2", outcome: "incorrect" }),
      makeEventDoc(session, { conceptId: "part_3", outcome: "correct" })
    );

    const { body } = await app.get(
      `/admin/analytics/overview?topic=${encodeURIComponent(pack.topic)}`,
      { token: app.asAdmin }
    );
    assert.equal(body.outcomesByConcept.topicSource, "given");
    const byConcept = new Map(body.outcomesByConcept.concepts.map((entry) => [entry.conceptId, entry]));
    assert.equal(byConcept.get("part_1").status, "mastered");
    assert.equal(byConcept.get("part_1").events, 2);
    assert.equal(byConcept.get("part_2").status, "struggling");
    assert.equal(byConcept.get("part_3").status, "emerging");
    assert.equal(byConcept.get("part_4").status, "unassessed");
    assert.equal(byConcept.get("part_4").events, 0);
  } finally {
    await app.close();
  }
});

test("a derived top topic with no pack degrades gracefully instead of 500ing", async () => {
  const app = await setup(); // no packs bundled or stored
  try {
    const session = makeSessionDoc(app.student, makePack({ topic: "Mystery Topic" }));
    app.store.sessions.push(session);
    app.store.events.push(
      makeEventDoc(session, { conceptId: "part_1", outcome: "incorrect" }),
      makeEventDoc(session, { conceptId: "part_1", outcome: "incorrect" })
    );

    const { status, body } = await app.get("/admin/analytics/overview", { token: app.asAdmin });
    assert.equal(status, 200);
    assert.equal(body.outcomesByConcept.topic, "Mystery Topic");
    assert.equal(body.outcomesByConcept.packAvailable, false);
    assert.equal(body.outcomesByConcept.concepts.length, 1);
    assert.equal(body.outcomesByConcept.concepts[0].status, "struggling");
  } finally {
    await app.close();
  }
});

test("an explicit topic with no pack is a 404, like everywhere else", async () => {
  const app = await setup();
  try {
    const { status, body } = await app.get("/admin/analytics/overview?topic=Gone%20Topic", {
      token: app.asAdmin,
    });
    assert.equal(status, 404);
    assert.equal(body.error, "topic_not_available");
  } finally {
    await app.close();
  }
});

test("an overlong topic is refused, and events from other topics stay out", async () => {
  const pack = makePack();
  const app = await setup({ bundled: [pack] });
  try {
    const sessionA1 = makeSessionDoc(app.student, pack);
    const sessionA2 = makeSessionDoc(app.student, pack);
    const sessionB = makeSessionDoc(app.student, pack, { topic: "Other Topic" });
    app.store.sessions.push(sessionA1, sessionA2, sessionB);
    app.store.events.push(
      makeEventDoc(sessionA1, { conceptId: "part_1", outcome: "correct" }),
      makeEventDoc(sessionA2, { conceptId: "part_1", outcome: "correct" }),
      makeEventDoc(sessionB, { conceptId: "part_1", outcome: "correct" })
    );

    const tooLong = await app.get("/admin/analytics/overview?topic=" + "x".repeat(121), {
      token: app.asAdmin,
    });
    assert.equal(tooLong.status, 400);

    const { body } = await app.get("/admin/analytics/overview", { token: app.asAdmin });
    // Both sessions share the same topic, so the aggregate counts both; Other Topic pack is absent,
    // so the derived default handled gracefully would show concepts from rows only:
    const topic = body.outcomesByConcept.topic;
    assert.equal(topic, pack.topic);
    assert.equal(
      body.outcomesByConcept.concepts.find((entry) => entry.conceptId === "part_1").events,
      2,
      "only events from sessions of that topic are counted"
    );
  } finally {
    await app.close();
  }
});
