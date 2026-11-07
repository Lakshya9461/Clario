// The Phase 3 routes, exercised over real HTTP with a fake store and a fake model.
// These tests are about the wiring: what a request does to the evidence log, what the client is
// allowed to see, and which failure is which status code.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { createRouter } = require("./routes");
const { LlmBusyError } = require("./llm");
const { toHttpError } = require("./errors");
const { makePack, makeSession, makeFakeChat, freeText } = require("./engine/fixtures");

async function setup({ packOverrides = {}, replies = {}, chatJson } = {}) {
  const pack = makePack({
    check: [
      makePack().check[0],
      freeText("c2", 2, { requiresWhy: true }),
      makePack().check[2],
    ],
    ...packOverrides,
  });
  const session = makeSession(pack);
  const events = [];
  const chat = makeFakeChat(replies);

  const app = express();
  app.use(express.json());
  app.use(
    createRouter({
      curatedPacks: () => [pack],
      findStored: async () => null,
      createSession: async (doc) => {
        Object.assign(session, doc);
        return session;
      },
      findSession: async (id) => (String(id) === String(session._id) ? session : null),
      claim: async (id, update) => {
        const questionId = update.$addToSet.answeredQuestionIds;
        if (session.answeredQuestionIds.includes(questionId)) return null;
        session.answeredQuestionIds.push(questionId);
        if (update.$set) Object.assign(session, update.$set);
        return session;
      },
      findEvents: async () => events,
      countEvents: async () => events.length,
      insertEvents: async (documents) => {
        events.push(...documents);
        return documents;
      },
      chatJson: chatJson ?? chat.fn,
      release: async (id, update) => {
        const questionId = update.$pull.answeredQuestionIds;
        session.answeredQuestionIds = session.answeredQuestionIds.filter(
          (entry) => entry !== questionId
        );
      },
    })
  );
  app.use((req, res) => res.status(404).json({ error: "not_found" }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const { status, body } = toHttpError(error);
    res.status(status).json(body);
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };

  return {
    pack,
    session,
    events,
    chat,
    post: (path, body) => call("POST", path, body),
    get: (path) => call("GET", path),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// --- POST /session --------------------------------------------------------

test("a session starts on an existing pack and hands out one question without its key", async () => {
  const harness = await setup();
  try {
    const { status, body } = await harness.post("/session", { topic: "sample topic", goal: "exam" });
    assert.equal(status, 201);
    assert.equal(body.topic, "Sample Topic");
    assert.equal(body.packStatus, "curated");
    assert.equal(body.goal, "exam");
    assert.equal(body.firstQuestion.id, "d1");
    assert.equal(body.done, false);
    assert.doesNotMatch(JSON.stringify(body), /answerKey|fallbackFeedback/);
    assert.match(body.sessionId, /^[0-9a-f]{24}$/);
  } finally {
    await harness.close();
  }
});

test("a topic with no pack is a 404, never a generation", async () => {
  const harness = await setup();
  try {
    const { status, body } = await harness.post("/session", { topic: "some other topic" });
    assert.equal(status, 404);
    assert.equal(body.error, "topic_not_available");
    assert.ok(harness.chat.calls.length === 0, "no model was called");
  } finally {
    await harness.close();
  }
});

test("a pasted source is refused instead of silently ignored", async () => {
  const harness = await setup();
  try {
    const { status, body } = await harness.post("/session", {
      topic: "Sample Topic",
      sourceText: "a long pasted document",
    });
    assert.equal(status, 400);
    assert.equal(body.error, "source_text_not_supported");
    assert.ok(harness.chat.calls.length === 0);
  } finally {
    await harness.close();
  }
});

test("an empty topic is a 400, not a 404", async () => {
  const harness = await setup();
  try {
    const { status, body } = await harness.post("/session", { topic: "   " });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_topic");
  } finally {
    await harness.close();
  }
});

// --- POST /diagnose ------------------------------------------------------

test("a keyed diagnostic answer is graded in code and logged as evidence", async () => {
  const harness = await setup();
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    const { status, body } = await harness.post("/diagnose", {
      sessionId: started.sessionId,
      questionId: "d1",
      answer: "option b",
    });

    assert.equal(status, 200);
    assert.equal(body.nextQuestion.id, "d2");
    assert.equal(body.done, false);
    assert.equal(body.lowEvidence, false);
    assert.equal(body.evidenceCount, 1);
    assert.equal(harness.events.length, 1);
    assert.equal(harness.events[0].gradedBy, "code");
    assert.equal(harness.events[0].outcome, "correct");
    assert.equal(harness.chat.calls.length, 0, "a keyed answer needs no model call");
  } finally {
    await harness.close();
  }
});

test("the same diagnostic question cannot be answered twice", async () => {
  const harness = await setup();
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    const first = await harness.post("/diagnose", {
      sessionId: started.sessionId,
      questionId: "d1",
      answer: "option b",
    });
    const second = await harness.post("/diagnose", {
      sessionId: started.sessionId,
      questionId: "d1",
      answer: "option b",
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, "question_already_answered");
    assert.equal(harness.events.length, 1, "no second set of evidence");
  } finally {
    await harness.close();
  }
});

test("skipping records no evidence, marks low evidence, and moves on", async () => {
  const harness = await setup();
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    const skip = await harness.post("/diagnose", {
      sessionId: started.sessionId,
      questionId: "d1",
      skip: true,
    });

    assert.equal(skip.status, 200);
    assert.equal(skip.body.lowEvidence, true);
    assert.equal(skip.body.nextQuestion.id, "d2");
    assert.equal(harness.events.length, 0, "a skip is not graded");
    assert.equal(harness.session.skippedDiagnosis, true);
  } finally {
    await harness.close();
  }
});

test("an empty answer is refused before anything is recorded", async () => {
  const harness = await setup();
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    const { status, body } = await harness.post("/diagnose", {
      sessionId: started.sessionId,
      questionId: "d1",
      answer: "  ",
    });

    assert.equal(status, 400);
    assert.equal(body.error, "invalid_answer");
    assert.equal(harness.events.length, 0);
    assert.equal(harness.session.answeredQuestionIds.length, 0, "the question is still askable");
  } finally {
    await harness.close();
  }
});

// A student text that goes into a prompt is bounded at the trust boundary: an unbounded one is a
// cost and an injection surface. The cap is far above a real answer, so only a pasted document
// is refused, and it is refused before the question is claimed or graded.
test("an answer over the cap is refused before the question is claimed", async () => {
  const harness = await setup();
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    const { status, body } = await harness.post("/diagnose", {
      sessionId: started.sessionId,
      questionId: "d1",
      answer: "x".repeat(4001),
    });

    assert.equal(status, 400);
    assert.equal(body.error, "answer_too_long");
    assert.match(body.message, /4000/, "the message has to say what the limit is");
    assert.equal(harness.chat.calls.length, 0, "no model call for a refused answer");
    assert.equal(harness.events.length, 0);
    assert.equal(harness.session.answeredQuestionIds.length, 0, "the question is still askable");
  } finally {
    await harness.close();
  }
});

test("an explanation over the cap is refused too, and an answer at the cap is accepted", async () => {
  const harness = await setup();
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });

    const tooLong = await harness.post("/check", {
      sessionId: started.sessionId,
      questionId: "c2",
      answer: "the answer",
      why: "y".repeat(4001),
    });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error, "answer_too_long");
    assert.equal(harness.session.answeredQuestionIds.length, 0, "nothing was claimed");

    const atCap = await harness.post("/check", {
      sessionId: started.sessionId,
      questionId: "c2",
      answer: "z".repeat(4000),
      why: "because the rubric is met",
    });
    assert.equal(atCap.status, 200);
    assert.equal(harness.session.answeredQuestionIds.length, 1);
  } finally {
    await harness.close();
  }
});

test("a question from another list is refused", async () => {
  const harness = await setup();
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    const { status, body } = await harness.post("/diagnose", {
      sessionId: started.sessionId,
      questionId: "c1",
      answer: "option b",
    });
    assert.equal(status, 400);
    assert.equal(body.error, "question_not_found");
  } finally {
    await harness.close();
  }
});

test("the diagnostic ends after three answers that cover every tier", async () => {
  const harness = await setup();
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    const answers = ["d1", "d2", "d3"];
    let last;
    for (const questionId of answers) {
      last = await harness.post("/diagnose", {
        sessionId: started.sessionId,
        questionId,
        answer: "option b",
      });
    }

    assert.equal(last.body.done, true);
    assert.equal(last.body.nextQuestion, null);
    assert.equal(last.body.answeredCount, 3);
    assert.equal(harness.events.length, 3);
  } finally {
    await harness.close();
  }
});

test("a written diagnostic answer is graded by the model", async () => {
  const pack = makePack({
    diagnostic: [
      makePack().diagnostic[0],
      freeText("d2", 2, { conceptIds: ["part_2"] }),
      makePack().diagnostic[2],
    ],
  });
  const harness = await setup({ packOverrides: pack });
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    await harness.post("/diagnose", { sessionId: started.sessionId, questionId: "d1", answer: "option b" });
    const { status, body } = await harness.post("/diagnose", {
      sessionId: started.sessionId,
      questionId: "d2",
      answer: "It names the idea and what it does.",
    });

    assert.equal(status, 200);
    assert.equal(body.nextQuestion.id, "d3");
    const written = harness.events.filter((event) => event.gradedBy === "llm");
    assert.equal(written.length, 1);
    assert.equal(written[0].evidenceQuality, "llm_graded");
    assert.equal(written[0].evidenceType, "demonstrated");
  } finally {
    await harness.close();
  }
});

test("a model that cannot grade records no evidence but does not block the flow", async () => {
  const harness = await setup({
    replies: { degraded: true },
    packOverrides: {
      diagnostic: [
        makePack().diagnostic[0],
        freeText("d2", 2, { conceptIds: ["part_2"] }),
        makePack().diagnostic[2],
      ],
    },
  });
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    const { status, body } = await harness.post("/diagnose", {
      sessionId: started.sessionId,
      questionId: "d2",
      answer: "an answer",
    });

    assert.equal(status, 200);
    assert.equal(body.evidenceCount, 0, "an ungraded answer leaves no evidence");
    assert.equal(body.nextQuestion.id, "d1");
  } finally {
    await harness.close();
  }
});

// --- POST /check ---------------------------------------------------------

test("the check hands out its first question when asked without one", async () => {
  const harness = await setup();
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    const { status, body } = await harness.post("/check", { sessionId: started.sessionId });

    assert.equal(status, 200);
    assert.equal(body.nextQuestion.id, "c1");
    assert.equal(body.checkComplete, false);
    assert.equal(body.correct, null);
    assert.equal(body.feedback, null);
    assert.doesNotMatch(JSON.stringify(body.nextQuestion), /answerKey|fallbackFeedback|rubric/);
    assert.equal(harness.events.length, 0, "asking for a question records nothing");
  } finally {
    await harness.close();
  }
});

test("the check runs three questions, rising, then completes", async () => {
  const harness = await setup();
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });

    const first = await harness.post("/check", {
      sessionId: started.sessionId,
      questionId: "c1",
      answer: "option b",
    });
    assert.equal(first.body.correct, true);
    assert.equal(first.body.nextQuestion.id, "c2");
    assert.equal(first.body.checkComplete, false);

    const second = await harness.post("/check", {
      sessionId: started.sessionId,
      questionId: "c2",
      answer: "It names the idea.",
      why: "because it says what the idea does",
    });
    assert.equal(second.body.nextQuestion.id, "c3");

    const third = await harness.post("/check", {
      sessionId: started.sessionId,
      questionId: "c3",
      answer: "option b",
    });
    assert.equal(third.body.checkComplete, true);
    assert.equal(third.body.nextQuestion, null);
    assert.equal(third.body.feedback.length > 0, true);
  } finally {
    await harness.close();
  }
});

test("a wrong keyed answer is reported wrong and still leaves evidence", async () => {
  const harness = await setup();
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    const { body } = await harness.post("/check", {
      sessionId: started.sessionId,
      questionId: "c1",
      answer: "option a",
    });

    assert.equal(body.correct, false);
    assert.equal(harness.events[0].outcome, "incorrect");
    assert.equal(harness.events[0].evidenceType, "demonstrated", "a wrong keyed answer is still evidence");
  } finally {
    await harness.close();
  }
});

test("feedback falls back to the pack's authored text when the model is unavailable", async () => {
  const harness = await setup({ replies: { degraded: true } });
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    const { body } = await harness.post("/check", {
      sessionId: started.sessionId,
      questionId: "c1",
      answer: "option a",
    });

    assert.equal(body.correct, false);
    assert.equal(body.feedback, harness.pack.check[0].fallbackFeedback.incorrect);
    assert.equal(body.degraded, true);
  } finally {
    await harness.close();
  }
});

test("a judged explanation adds its own evidence event", async () => {
  const harness = await setup({
    replies: {
      feedback: { feedback: "Close.", whyOutcome: "partial", whyNote: "Could say why it works." },
    },
  });
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    await harness.post("/check", {
      sessionId: started.sessionId,
      questionId: "c2",
      answer: "It names the idea.",
      why: "it works",
    });

    const why = harness.events.filter((event) => event.questionId === "c2" && event.note === "Could say why it works.");
    assert.equal(why.length, 1);
    assert.equal(why[0].evidenceType, "inferred");
  } finally {
    await harness.close();
  }
});

test("the key is never in a check response", async () => {
  const harness = await setup();
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    const { body } = await harness.post("/check", {
      sessionId: started.sessionId,
      questionId: "c1",
      answer: "option a",
    });
    assert.doesNotMatch(JSON.stringify(body.nextQuestion), /answerKey|fallbackFeedback|rubric/);
  } finally {
    await harness.close();
  }
});

// --- GET /plan, POST /lesson, GET /model ---------------------------------

test("the plan reports findings for every concept and steps for the unassessed ones", async () => {
  const harness = await setup();
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    await harness.post("/diagnose", {
      sessionId: started.sessionId,
      questionId: "d1",
      answer: "option b",
    });

    const { status, body } = await harness.get(`/plan/${started.sessionId}`);
    assert.equal(status, 200);
    assert.equal(body.findings.length, harness.pack.concepts.length);
    assert.equal(body.objective.length > 0, true);
    // One wrong answer leaves the concept developing, so it stays a step: only a demonstration
    // takes it off the plan.
    assert.equal(body.findings[0].status, "developing");
    assert.equal(body.steps[0].conceptId, "part_1");
    assert.equal(body.degraded, false);
    assert.equal(body.findings[0].certainty, null, "one answer is not a demonstration");
  } finally {
    await harness.close();
  }
});

test("a plan for a session that does not exist is a 404", async () => {
  const harness = await setup();
  try {
    const { status, body } = await harness.get("/plan/0123456789abcdef01234567");
    assert.equal(status, 404);
    assert.equal(body.error, "session_not_found");
  } finally {
    await harness.close();
  }
});

test("a lesson for a plan step carries only citations the pack has", async () => {
  const harness = await setup({
    replies: {
      lesson: {
        markdown: "## Part 1\n\nA short explanation [1].",
        usedSourceIds: ["s1", "s-invented"],
        workedExample: "A worked example.",
      },
    },
  });
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    const { status, body } = await harness.post("/lesson", {
      sessionId: started.sessionId,
      stepIndex: 0,
    });

    assert.equal(status, 200);
    assert.equal(body.conceptId, "part_1");
    assert.deepEqual(body.citations, [
      { sourceId: "s1", title: "Source One", url: "https://example.test/one" },
    ]);
    assert.equal(body.trace, null);
    assert.equal(body.workedExample, "A worked example.");
  } finally {
    await harness.close();
  }
});

test("a step index outside the plan is a 400", async () => {
  const harness = await setup();
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    const { status, body } = await harness.post("/lesson", {
      sessionId: started.sessionId,
      stepIndex: 99,
    });
    assert.equal(status, 400);
    assert.equal(body.error, "step_not_found");
  } finally {
    await harness.close();
  }
});

test("the learner model shows unassessed concepts as unknown, with notes from evidence", async () => {
  const harness = await setup();
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    await harness.post("/diagnose", {
      sessionId: started.sessionId,
      questionId: "d1",
      answer: "option a",
    });

    const { status, body } = await harness.get(`/model/${started.sessionId}`);
    assert.equal(status, 200);
    const assessed = body.concepts.find((concept) => concept.id === "part_1");
    const unassessed = body.concepts.find((concept) => concept.id === "part_5");

    assert.equal(assessed.status, "developing");
    assert.equal(assessed.eventCount, 1);
    assert.equal(assessed.notes.length, 1);
    assert.equal(unassessed.status, "unknown");
    assert.deepEqual(unassessed.notes, []);
    assert.equal(body.lowEvidence, false);
  } finally {
    await harness.close();
  }
});

// --- self-report questions and a released claim ---------------------------

// A scale question: no key, no rubric, so there is nothing to grade and nothing for the model to
// decide. The pack marks it, which is what a generated pack does for a "how comfortable are you"
// item.
function selfReportQuestion(id, difficulty) {
  return {
    id,
    kind: "mcq",
    prompt: "How comfortable are you with this idea so far?",
    options: ["Not yet", "Getting there", "Confident"],
    conceptIds: ["part_2"],
    difficulty,
    transfer: false,
    requiresWhy: false,
    answerKey: null,
    selfReport: true,
    fallbackFeedback: { correct: "Noted.", incorrect: "Noted." },
  };
}

test("a self-report answer is the student's own claim, with no model call", async () => {
  const question = selfReportQuestion("d1", 1);
  const harness = await setup({
    packOverrides: { diagnostic: [question, ...makePack().diagnostic.slice(1)] },
  });
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    assert.equal(started.firstQuestion.id, "d1");

    const { status, body } = await harness.post("/diagnose", {
      sessionId: started.sessionId,
      questionId: "d1",
      answer: question.options[2],
    });

    assert.equal(status, 200);
    assert.equal(harness.chat.calls.length, 0, "a self rating must never reach the model");
    assert.equal(body.evidenceCount, 1);
    assert.equal(harness.events.length, 1);

    const [event] = harness.events;
    assert.equal(event.evidenceType, "self_report");
    assert.equal(event.gradedBy, "student");
    assert.equal(event.evidenceQuality, null);
    assert.equal(event.outcome, "correct");
  } finally {
    await harness.close();
  }
});

test("the bottom of a self-report scale is unsure, and it stays self_reported in the model", async () => {
  const question = selfReportQuestion("d1", 1);
  const harness = await setup({
    packOverrides: { diagnostic: [question, ...makePack().diagnostic.slice(1)] },
  });
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    await harness.post("/diagnose", {
      sessionId: started.sessionId,
      questionId: "d1",
      answer: question.options[0],
    });

    assert.equal(harness.events[0].outcome, "unsure");

    const { body: model } = await harness.get(`/model/${started.sessionId}`);
    const concept = model.concepts.find((entry) => entry.id === "part_2");
    assert.equal(concept.status, "self_reported", "a claim is never reported as demonstrated");
    assert.equal(concept.eventCount, 1);
  } finally {
    await harness.close();
  }
});

test("a self-report check question is not graded and does not ask for feedback", async () => {
  const question = selfReportQuestion("c1", 1);
  const harness = await setup({ packOverrides: { check: [question] } });
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    const { status, body } = await harness.post("/check", {
      sessionId: started.sessionId,
      questionId: "c1",
      answer: question.options[1],
    });

    assert.equal(status, 200);
    assert.equal(harness.chat.calls.length, 0);
    assert.equal(body.selfReport, true);
    assert.equal(body.correct, null, "a claim is neither right nor wrong");
    assert.match(body.feedback, /your own rating/i);
    assert.equal(harness.events[0].evidenceType, "self_report");
  } finally {
    await harness.close();
  }
});

test("a busy model releases the diagnostic claim so the retry can grade the answer", async () => {
  const chat = makeFakeChat();
  let busy = true;
  const harness = await setup({
    packOverrides: {
      diagnostic: [freeText("d1", 1), ...makePack().diagnostic.slice(1)],
    },
    chatJson: (messages, schema, fallback, options) =>
      busy ? Promise.reject(new LlmBusyError()) : chat.fn(messages, schema, fallback, options),
  });
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });

    const first = await harness.post("/diagnose", {
      sessionId: started.sessionId,
      questionId: "d1",
      answer: "An answer that needs grading.",
    });
    assert.equal(first.status, 503);
    assert.equal(first.body.error, "busy");
    assert.equal(harness.events.length, 0);
    assert.deepEqual(harness.session.answeredQuestionIds, [], "the claim goes back");

    busy = false;
    const retry = await harness.post("/diagnose", {
      sessionId: started.sessionId,
      questionId: "d1",
      answer: "An answer that needs grading.",
    });
    assert.equal(retry.status, 200, "the retry grades instead of answering 409");
    assert.equal(harness.events.length, 1);
  } finally {
    await harness.close();
  }
});

test("a busy model releases the check claim too", async () => {
  const chat = makeFakeChat();
  let busy = true;
  const harness = await setup({
    chatJson: (messages, schema, fallback, options) =>
      busy ? Promise.reject(new LlmBusyError()) : chat.fn(messages, schema, fallback, options),
  });
  try {
    const { body: started } = await harness.post("/session", { topic: "Sample Topic" });
    const answer = { sessionId: started.sessionId, questionId: "c2", answer: "An explanation." };

    const first = await harness.post("/check", answer);
    assert.equal(first.status, 503);
    assert.equal(harness.events.length, 0);
    assert.deepEqual(harness.session.answeredQuestionIds, []);

    busy = false;
    const retry = await harness.post("/check", answer);
    assert.equal(retry.status, 200);
    assert.ok(harness.events.length >= 1);
  } finally {
    await harness.close();
  }
});
