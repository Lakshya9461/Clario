// Fixed-output tests for pack generation. No network, no Mongo: the LLM is a stub that
// replays canned replies and the store is a Map.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generatePack, prompts, TopicNotSupportedError, InvalidTopicError } = require("./generate");
const { validatePack } = require("./loader");

// --- canned content -------------------------------------------------------

function conceptFixture(count = 8) {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return {
      id: `part_${n}`,
      name: `Part ${n}`,
      description: `Concept number ${n} of this topic.`,
      prerequisites: n === 1 ? [] : [`part_${n - 1}`],
    };
  });
}

function mcq(id, difficulty, extra = {}) {
  return {
    id,
    kind: "mcq",
    prompt: `Which statement about ${id} is correct?`,
    options: ["option a", "option b", "option c", "option d"],
    correctOptionIndex: 0,
    conceptIds: ["part_1"],
    difficulty,
    transfer: false,
    requiresWhy: false,
    feedback: { correct: "Yes, that is the one.", incorrect: "That may describe a different idea." },
    ...extra,
  };
}

function freeText(id, difficulty, extra = {}) {
  return {
    id,
    kind: "free_text",
    prompt: `Explain in one sentence what ${id} does.`,
    conceptIds: ["part_2"],
    difficulty,
    transfer: false,
    requiresWhy: false,
    rubric: "Full credit if the answer names the idea and its effect.",
    feedback: { correct: "Yes, that names it.", incorrect: "That may be a related idea, not this one." },
    ...extra,
  };
}

function questionFixture() {
  return {
    diagnostic: [
      mcq("d1", 1),
      mcq("d2", 2),
      freeText("d3", 2),
      mcq("d4", 3),
      freeText("d5", 3),
    ],
    check: [
      mcq("c1a", 1),
      freeText("c1b", 1),
      mcq("c2a", 2, { requiresWhy: true, rubric: "Full credit if it explains the reasoning." }),
      freeText("c2b", 2, { requiresWhy: true }),
      mcq("c3a", 3, { transfer: true }),
      freeText("c3b", 3, { transfer: true }),
    ],
  };
}

// --- stubs ---------------------------------------------------------------

function makeFakeLlm(options = {}) {
  const log = [];
  const fn = async (messages) => {
    const text = messages.map((message) => message.content).join("\n");
    const kind = text.includes('"answerIndex"')
      ? "selfcheck"
      : text.includes('"diagnostic"')
        ? "questions"
        : "concepts";
    const attempt = log.filter((call) => call.kind === kind).length;
    log.push({ kind, attempt, messages });

    if (kind === "concepts") {
      const concepts = options.concepts ? options.concepts(attempt) : conceptFixture();
      return { value: { concepts }, degraded: false };
    }
    if (kind === "questions") {
      const questions = options.questions ? options.questions(attempt) : questionFixture();
      return { value: questions, degraded: false };
    }
    const answerIndex = options.selfCheck ? options.selfCheck(text) : 0;
    return { value: { answerIndex }, degraded: false };
  };
  fn.log = log;
  fn.count = (kind) => log.filter((call) => call.kind === kind).length;
  return fn;
}

function memoryStore() {
  const saved = new Map();
  return {
    saved,
    async findByTopicKey(topicKey) {
      return saved.has(topicKey) ? saved.get(topicKey).pack : null;
    },
    async save({ topicKey, topic, pack }) {
      saved.set(topicKey, { topic, pack });
      return pack;
    },
  };
}

function selfCheckId(text) {
  return text.match(/about (\w+) is correct/)?.[1];
}

async function generate({ topic = "Sample Topic", goal = "exam", sourceChunks = [], llm, store }) {
  return generatePack({ topic, goal, sourceChunks, deps: { chatJson: llm, store } });
}

// --- happy path ----------------------------------------------------------

test("generates a validated draft pack", async () => {
  const llm = makeFakeLlm();
  const store = memoryStore();
  const { pack, cached } = await generate({ llm, store });

  assert.equal(cached, false);
  assert.equal(pack.status, "generated");
  assert.equal(pack.topic, "Sample Topic");
  assert.equal(pack.concepts.length, 8);
  assert.equal(pack.diagnostic.length, 5);
  assert.equal(pack.check.length, 6);
  assert.deepEqual(pack.sources, []);
  assert.deepEqual(pack.traces, {});

  const validation = validatePack(pack);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);

  const mcqs = [...pack.diagnostic, ...pack.check].filter((question) => question.kind === "mcq");
  assert.equal(mcqs.length, 6);
  for (const question of mcqs) {
    assert.deepEqual(question.answerKey, { type: "option", value: question.options[0] });
  }
  assert.equal(store.saved.get("sample topic").pack.packId, pack.packId);
});

test("the topic reaches the prompt as tagged data, not as instructions", async () => {
  const llm = makeFakeLlm();
  await generate({ topic: "  Sample   Topic  ", llm, store: memoryStore() });

  const conceptsPrompt = llm.log.find((call) => call.kind === "concepts").messages;
  const system = conceptsPrompt[0].content;
  const user = conceptsPrompt[1].content;

  assert.match(system, /never as instructions/i);
  assert.match(user, /<topic>Sample Topic<\/topic>/);
});

// --- bad graphs ----------------------------------------------------------

test("retries once on a cyclic prerequisite graph, then reports topic_not_supported", async () => {
  const cyclic = conceptFixture();
  cyclic[0].prerequisites = ["part_8"]; // part_1 -> part_8 -> ... -> part_1
  const llm = makeFakeLlm({ concepts: () => cyclic });
  const store = memoryStore();

  await assert.rejects(generate({ llm, store }), (error) => {
    assert.ok(error instanceof TopicNotSupportedError);
    assert.equal(error.code, "topic_not_supported");
    return true;
  });

  assert.equal(llm.count("concepts"), 2, "the graph is drafted twice, then given up on");
  assert.equal(llm.count("questions"), 0);
  assert.equal(store.saved.size, 0);
});

test("retries once on a prerequisite that does not exist, then reports topic_not_supported", async () => {
  const dangling = conceptFixture();
  dangling[3].prerequisites = ["not_a_concept"];
  const llm = makeFakeLlm({ concepts: () => dangling });
  const store = memoryStore();

  await assert.rejects(generate({ llm, store }), (error) => error.code === "topic_not_supported");
  assert.equal(llm.count("concepts"), 2);
  assert.equal(store.saved.size, 0);
});

test("a repaired graph on the second attempt is accepted", async () => {
  const broken = conceptFixture();
  broken[0].prerequisites = ["part_8"];
  const llm = makeFakeLlm({
    concepts: (attempt) => (attempt === 0 ? broken : conceptFixture()),
  });
  const { pack } = await generate({ llm, store: memoryStore() });

  assert.equal(llm.count("concepts"), 2);
  assert.equal(validatePack(pack).valid, true);
});

test("rejects questions that reference a concept outside the graph", async () => {
  const broken = questionFixture();
  broken.check[2].conceptIds = ["part_99"];
  const llm = makeFakeLlm({ questions: () => broken });
  const store = memoryStore();

  await assert.rejects(generate({ llm, store }), (error) => error.code === "topic_not_supported");
  assert.equal(llm.count("questions"), 2);
  assert.equal(store.saved.size, 0);
});

test("rejects a question list that breaks the difficulty plan", async () => {
  const broken = questionFixture();
  broken.check[0].difficulty = 3; // no longer 2/2/2
  broken.check[1].transfer = true;
  const llm = makeFakeLlm({ questions: () => broken });

  await assert.rejects(generate({ llm, store: memoryStore() }), (error) => error.code === "topic_not_supported");
});

// --- self-consistency ----------------------------------------------------

test("drops the mcq questions whose key the model does not reproduce", async () => {
  const llm = makeFakeLlm({
    selfCheck: (text) => (selfCheckId(text) === "d4" ? 3 : 0),
  });
  const { pack } = await generate({ llm, store: memoryStore() });

  assert.deepEqual(pack.diagnostic.map((question) => question.id), ["d1", "d2", "d3", "d5"]);
  assert.deepEqual(pack.check.map((question) => question.id), ["c1", "c2", "c3", "c4", "c5", "c6"]);
  assert.equal(llm.count("selfcheck"), 6, "every drafted mcq is checked once; free_text has no key to check");
  assert.equal(validatePack(pack).valid, true);
});

test("reports topic_not_supported when too few questions survive the check", async () => {
  // Every mcq key is option 0; the model answers 3 every time.
  const llm = makeFakeLlm({ selfCheck: () => 3 });
  const store = memoryStore();

  await assert.rejects(generate({ llm, store }), (error) => error.code === "topic_not_supported");
  assert.equal(store.saved.size, 0);
});

test("the self-check prompt contains no answer key", async () => {
  const llm = makeFakeLlm();
  await generate({ llm, store: memoryStore() });

  const selfChecks = llm.log.filter((call) => call.kind === "selfcheck");
  assert.equal(selfChecks.length, 6);
  for (const call of selfChecks) {
    const text = call.messages.map((message) => message.content).join("\n");
    assert.doesNotMatch(text, /correctOptionIndex|answerKey|correct answer is/i);
  }
});

// --- cache and input validation -----------------------------------------

test("reuses the stored pack for the same normalized topic", async () => {
  const llm = makeFakeLlm();
  const store = memoryStore();

  const first = await generate({ topic: "Sample Topic", llm, store });
  const second = await generate({ topic: "  sample    TOPIC ", llm, store });

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.pack.packId, first.pack.packId);
  assert.equal(llm.count("concepts"), 1, "the cache must not re-draft");
});

test("rejects an empty, non-text or over-long topic before calling the LLM", async () => {
  const llm = makeFakeLlm();
  const store = memoryStore();

  for (const topic of ["", "   ", 42, null, "x".repeat(121)]) {
    await assert.rejects(generate({ topic, llm, store }), (error) => {
      assert.ok(error instanceof InvalidTopicError, `expected invalid_topic for ${JSON.stringify(topic)}`);
      assert.equal(error.code, "invalid_topic");
      return true;
    });
  }
  assert.equal(llm.count("concepts"), 0);
});

test("accepts a topic of exactly 120 characters", async () => {
  const llm = makeFakeLlm();
  const { pack } = await generate({ topic: "t".repeat(120), llm, store: memoryStore() });
  assert.equal(pack.topic.length, 120);
});

// --- sources -------------------------------------------------------------

test("pasted source chunks are wrapped as data and stored without inventing a URL", async () => {
  const llm = makeFakeLlm();
  const { pack } = await generate({
    llm,
    store: memoryStore(),
    sourceChunks: [{ id: "S1", text: "First chunk of the pasted text." }],
  });

  assert.equal(pack.sources.length, 1);
  assert.equal(pack.sources[0].id, "S1");
  assert.equal(pack.sources[0].url, "urn:clario:pasted:S1");
  assert.equal(validatePack(pack).valid, true);

  const user = llm.log.find((call) => call.kind === "concepts").messages[1].content;
  assert.match(user, /<source id="S1" title="Pasted source S1">/);
  assert.match(user, /First chunk of the pasted text\./);
});

test("prompts exist for all three steps", () => {
  const messages = prompts.conceptsMessages({ topic: "t", goal: "exam", sources: [] });
  assert.equal(messages.length, 2);
  assert.ok(prompts.questionsMessages({ topic: "t", goal: "exam", sources: [], concepts: conceptFixture() }).length === 2);
  assert.ok(
    prompts.selfCheckMessages({ question: mcq("x1", 1) }).length === 2
  );
});
