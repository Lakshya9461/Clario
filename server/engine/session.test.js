// Session rules: which question comes next, when the diagnostic is done, and which pack a
// session may run on. Pure functions are called directly; the pack lookups use injected stores.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_DIAGNOSTIC,
  TopicNotAvailableError,
  SessionNotFoundError,
  QuestionNotFoundError,
  resolvePack,
  listTopics,
  packForSession,
  createSession,
  loadSession,
  claimQuestion,
  publicQuestion,
  nextDiagnosticQuestion,
  diagnosisComplete,
  nextCheckQuestion,
  checkComplete,
  findQuestion,
  certaintyFor,
} = require("./session");
const { makePack, makeSession, mcq } = require("./fixtures");

// --- next question --------------------------------------------------------

test("the diagnostic prefers a difficulty that has not been assessed", () => {
  const pack = makePack();
  // d4 is the easy question nearest the start; with nothing answered it is asked first.
  assert.equal(nextDiagnosticQuestion(pack, []).id, "d1");
  // d1 and d4 are both tier 1: having asked d1, the next uncovered tier is 2, so d2.
  assert.equal(nextDiagnosticQuestion(pack, ["d1"]).id, "d2");
  // Tiers 1 and 2 are covered, so tier 3 comes before the spare easy questions.
  assert.equal(nextDiagnosticQuestion(pack, ["d1", "d2"]).id, "d3");
  // Every tier is covered: the spare questions are asked in pack order.
  assert.equal(nextDiagnosticQuestion(pack, ["d1", "d2", "d3"]).id, "d4");
});

test("a question that has been answered is never offered again", () => {
  const pack = makePack();
  const asked = pack.diagnostic.map((question) => question.id);
  assert.equal(nextDiagnosticQuestion(pack, asked), null);
});

test("the diagnostic stops at 3 answered questions only when they cover every tier", () => {
  const pack = makePack();
  assert.equal(diagnosisComplete(pack, []), false);
  assert.equal(diagnosisComplete(pack, ["d1"]), false);
  // Two questions is below the floor however well they are spread.
  assert.equal(diagnosisComplete(pack, ["d1", "d2"]), false);
  // Three, but only two tiers: the plan would be built from one kind of question.
  assert.equal(diagnosisComplete(pack, ["d1", "d4", "d2"]), false);
  assert.equal(diagnosisComplete(pack, ["d1", "d2", "d3"]), true);
  // The hard cap applies even without full coverage.
  const five = pack.diagnostic.slice(0, MAX_DIAGNOSTIC).map((question) => question.id);
  assert.equal(diagnosisComplete(pack, five), true);
});

// --- check ----------------------------------------------------------------

test("the check runs one question per tier, rising, never repeated", () => {
  const pack = makePack();
  assert.equal(nextCheckQuestion(pack, []).id, "c1");
  assert.equal(nextCheckQuestion(pack, ["c1"]).id, "c2");
  assert.equal(nextCheckQuestion(pack, ["c2", "c1"]).id, "c3");
  assert.equal(nextCheckQuestion(pack, ["c1", "c2", "c3"]), null);
});

test("the check moves to the next tier even when a tier has spare questions", () => {
  const base = makePack();
  const pack = makePack({
    check: [
      base.check[0],
      mcq("c1b", 1),
      base.check[1],
      mcq("c2b", 2),
      base.check[2],
    ],
  });
  // Answering the first tier-1 question must not serve the spare tier-1 question.
  assert.equal(nextCheckQuestion(pack, ["c1"]).id, "c2");
  assert.equal(nextCheckQuestion(pack, ["c1", "c2"]).id, "c3");
  assert.equal(nextCheckQuestion(pack, ["c1", "c2", "c3"]), null);
  assert.equal(checkComplete(pack, ["c1", "c2", "c3"]), true);
});

test("the check is complete only when every tier has been answered", () => {
  const pack = makePack();
  assert.equal(checkComplete(pack, ["c1", "c2"]), false);
  // A diagnostic question does not count towards the check.
  assert.equal(checkComplete(pack, ["d1", "d2", "d3"]), false);
  assert.equal(checkComplete(pack, ["c1", "c2", "c3"]), true);
});

test("a question from the other list is rejected", () => {
  const pack = makePack();
  assert.throws(() => findQuestion(pack, "check", "d1"), QuestionNotFoundError);
  assert.throws(() => findQuestion(pack, "diagnostic", "nope"), QuestionNotFoundError);
  assert.equal(findQuestion(pack, "diagnostic", "d1").id, "d1");
});

// --- what the client may see ---------------------------------------------

test("the answer key, rubric and fallback feedback never reach the client", () => {
  const pack = makePack();
  const visible = publicQuestion(pack.diagnostic[0]);
  assert.equal(visible.answerKey, undefined);
  assert.equal(visible.rubric, undefined);
  assert.equal(visible.fallbackFeedback, undefined);
  assert.deepEqual(visible.options, ["option a", "option b", "option c", "option d"]);
  assert.equal(visible.id, "d1");
  // The whole point: serialising the visible question cannot leak the key.
  assert.doesNotMatch(JSON.stringify(visible), /option b"?\s*\}|answerKey/);
});

test("only a curated, code-keyed demonstration is stated as demonstrated", () => {
  assert.equal(
    certaintyFor("curated", { status: "demonstrated", evidenceQuality: "code_keyed" }),
    "demonstrated"
  );
  assert.equal(
    certaintyFor("generated", { status: "demonstrated", evidenceQuality: "llm_keyed" }),
    "likely demonstrated"
  );
  assert.equal(
    certaintyFor("curated", { status: "demonstrated", evidenceQuality: "llm_graded" }),
    "likely demonstrated"
  );
  assert.equal(certaintyFor("curated", { status: "developing", evidenceQuality: null }), null);
});

// --- packs ----------------------------------------------------------------

test("a curated pack is matched by topic, ignoring case and spacing", async () => {
  const pack = makePack();
  const deps = { bundledPacks: () => [pack], findStored: async () => null };
  assert.equal((await resolvePack("  sample   TOPIC ", deps)).packId, "sample-1");
});

test("a stored generated pack is the fallback when no curated pack matches", async () => {
  const pack = makePack({ status: "generated", packId: "generated-1" });
  const deps = {
    bundledPacks: () => [],
    findStored: async (topicKey) => (topicKey === "sample topic" ? { pack } : null),
  };
  assert.equal((await resolvePack("Sample Topic", deps)).packId, "generated-1");
});

test("a topic with no pack is refused, not generated", async () => {
  const deps = { bundledPacks: () => [], findStored: async () => null };
  await assert.rejects(resolvePack("Unknown Topic", deps), TopicNotAvailableError);
  // The error is what the client is allowed to see.
  await assert.rejects(resolvePack("Unknown Topic", deps), (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.code, "topic_not_available");
    assert.equal(error.expose, true);
    return true;
  });
});

test("a session refuses a pack whose id has changed under it", async () => {
  const pack = makePack({ status: "generated", packId: "generated-2" });
  const session = makeSession(pack, { packId: "generated-1", packStatus: "generated" });
  await assert.rejects(
    packForSession(session, { findStored: async () => ({ pack }) }),
    TopicNotAvailableError
  );
});

test("a curated session finds its pack by id, not by topic", async () => {
  const pack = makePack();
  const session = makeSession(pack, { packId: "other-pack" });
  await assert.rejects(
    packForSession(session, { bundledPacks: () => [pack], findStored: async () => null }),
    TopicNotAvailableError
  );
});

test("a reviewed generated pack bundled as a file is found without the store", async () => {
  const pack = makePack({ status: "generated", packId: "generated-file" });
  const deps = { bundledPacks: () => [pack], findStored: async () => null };
  assert.equal((await resolvePack("Sample Topic", deps)).packId, "generated-file");
});

test("topics lists curated first, then bundled, then stored, once each", async () => {
  const curated = makePack({ topic: "Curated Topic" });
  const bundled = makePack({ topic: "Bundled Topic", status: "generated", packId: "g1" });
  const stored = makePack({ topic: "Stored Topic", status: "generated", packId: "g2" });
  const same = makePack({ topic: "bundled topic", status: "generated", packId: "g3" });

  const topics = await listTopics({
    bundledPacks: () => [bundled, curated],
    listStored: async () => [
      { pack: stored },
      { pack: same },
      { pack: makePack({ topic: "curated topic", status: "generated" }) },
    ],
  });

  // A bundled generated pack was key-checked before it was committed; one that is only in the store
  // may be as the model wrote it, so the two are not reported the same way.
  assert.deepEqual(topics, [
    { topic: "Curated Topic", source: "curated", reviewed: true },
    { topic: "Bundled Topic", source: "generated", reviewed: true },
    { topic: "Stored Topic", source: "generated", reviewed: false },
  ]);
});

// --- session records ------------------------------------------------------

test("a malformed or missing session id is a 404, not a crash", async () => {
  const deps = { findSession: async () => null };
  await assert.rejects(loadSession({ sessionId: "not-an-id", deps }), SessionNotFoundError);
  await assert.rejects(loadSession({ sessionId: undefined, deps }), SessionNotFoundError);
});

test("creating a session copies the pack's own topic, id and status", async () => {
  const pack = makePack({ status: "generated", packId: "generated-3" });
  let stored = null;
  const { session } = await createSession({
    topic: "SAMPLE  topic",
    goal: "exam",
    deps: {
      bundledPacks: () => [pack],
      createSession: async (doc) => {
        stored = doc;
        return { _id: "id", ...doc };
      },
    },
  });
  assert.equal(stored.topic, pack.topic, "the pack's spelling is stored, not the student's");
  assert.equal(stored.packId, "generated-3");
  assert.equal(stored.packStatus, "generated");
  assert.equal(stored.title, pack.topic, "a new session is named after the pack it runs on");
  assert.equal(session.goal, "exam");
});

test("an approved stored pack is offered as curated, because a person checked every key", async () => {
  const approved = makePack({ topic: "Approved Topic", status: "curated", packId: "approved-1" });
  const drafted = makePack({ topic: "Draft Topic", status: "generated", packId: "draft-1" });

  const topics = await listTopics({
    bundledPacks: () => [],
    listStored: async () => [{ pack: drafted }, { pack: approved }],
  });

  assert.deepEqual(topics, [
    { topic: "Draft Topic", source: "generated", reviewed: false },
    // Only an admin's approval changes this store's answer, and it makes the pack curated.
    { topic: "Approved Topic", source: "curated", reviewed: true },
  ]);
});

// A4 hangs off the pack a session STARTED on. Approving a stored pack while sessions are running on
// it must not rewrite what the old keys were worth.
test("a session keeps the pack status it started on after the stored pack is approved", async () => {
  const nowCurated = makePack({ status: "curated", packId: "promoted-1", topic: "Promoted Topic" });
  const session = makeSession(nowCurated, { packStatus: "generated" });

  const loaded = await loadSession({
    sessionId: String(session._id),
    deps: {
      findSession: async () => session,
      findStored: async () => ({ pack: nowCurated }),
    },
  });

  assert.equal(loaded.pack.status, "generated", "the evidence was graded by the model's keys");
  assert.equal(loaded.pack.packId, "promoted-1", "the same pack, wearing its start-time status");
  assert.equal(nowCurated.status, "curated", "the stored pack itself was not modified");
});

test("claiming an answer twice reports the second claim as taken", async () => {
  const pack = makePack();
  const session = makeSession(pack);
  const answered = new Set();
  const deps = {
    claim: async (id, update) => {
      const questionId = update.$addToSet.answeredQuestionIds;
      if (answered.has(questionId)) return null;
      answered.add(questionId);
      return { _id: id };
    },
  };
  assert.equal(await claimQuestion({ session, questionId: "d1", deps }), true);
  assert.equal(await claimQuestion({ session, questionId: "d1", deps }), false);
});

test("a skipped claim also marks the diagnosis as low evidence", async () => {
  const pack = makePack();
  const session = makeSession(pack);
  let seen = null;
  const deps = {
    claim: async (id, update) => {
      seen = update;
      return { _id: id };
    },
  };
  await claimQuestion({ session, questionId: "d1", skipped: true, deps });
  assert.deepEqual(seen.$set, { skippedDiagnosis: true });
});
