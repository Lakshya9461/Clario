// Phase 3 routes: start a session, answer diagnostic questions, read the plan, read a lesson,
// take the check, read the learner model.
//
// Every route follows the same shape: load the session and its pack (404 if either is gone),
// do the deterministic engine work, call the LLM only for wording or grading, and return
// { error, message } on failure through errors.js. No route generates a pack — that is an offline
// script (A3), because generation takes minutes and a request may not.
//
// The routes take their dependencies as an argument so tests can drive them with a fake store and
// a fake model; production passes nothing and gets Mongoose and llm.js.

const express = require("express");
const { EvidenceEvent, computeEstimate } = require("./models/models");
const { chatJson } = require("./llm");
const {
  InvalidAnswerError,
  QuestionAlreadyAnsweredError,
  SourceTextNotSupportedError,
  claimQuestion,
  checkComplete,
  createSession,
  diagnosisComplete,
  findQuestion,
  loadSession,
  nextCheckQuestion,
  nextDiagnosticQuestion,
  publicQuestion,
  MIN_DIAGNOSTIC,
} = require("./engine/session");
const { buildPlan, planSteps, stepAt } = require("./engine/plan");
const { buildLesson } = require("./engine/lesson");
const { gradeKeyed, gradeWritten, keyedEvents, writeFeedback } = require("./engine/grading");

const defaultDeps = {
  chatJson,
  findEvents: (sessionId) => EvidenceEvent.find({ sessionId }).lean(),
  countEvents: (sessionId) => EvidenceEvent.countDocuments({ sessionId }),
  insertEvents: (documents) => EvidenceEvent.insertMany(documents),
};

// Evidence is append-only, and an event may only name a concept of the pack it belongs to:
// the grader already restricts itself to the question's concepts, and this is the last check
// before anything is written.
async function appendEvents({ sessionId, pack, events, deps }) {
  const conceptIds = new Set(pack.concepts.map((concept) => concept.id));
  const documents = events
    .filter((event) => conceptIds.has(event.conceptId))
    .map((event) => ({
      ...event,
      sessionId,
      note: String(event.note ?? "").slice(0, 300),
    }));
  if (!documents.length) return 0;
  await deps.insertEvents(documents);
  return documents.length;
}

// The loaded session is a snapshot taken before the claim, so the id just claimed is added here.
// A Set because counting the same id twice would end a 3-question diagnostic after two answers.
function answersWith(session, questionId) {
  return Array.from(new Set([...(session.answeredQuestionIds || []), questionId]));
}

function requireAnswer(answer) {
  if (typeof answer !== "string" || !answer.trim()) throw new InvalidAnswerError();
  return answer;
}

// A keyed question is graded in code, exactly. Everything else is graded by the model, which may
// only propose evidence; a failed grading records nothing rather than inventing it.
async function gradeAnswer({ question, answer, why, pack, deps }) {
  const keyed = gradeKeyed(question, answer);
  if (keyed) {
    return {
      correct: keyed.outcome === "correct",
      events: keyedEvents({ question, outcome: keyed.outcome, packStatus: pack.status }),
      degraded: false,
    };
  }
  const graded = await gradeWritten({ question, answer, why, chatJsonFn: deps.chatJson });
  const events = graded.events || [];
  return {
    // Only a fully correct written answer counts as correct. A partial one is evidence, not a pass.
    correct: events.length > 0 && events.every((event) => event.outcome === "correct"),
    events,
    degraded: graded.degraded,
  };
}

function createRouter(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const router = express.Router();

  // A3 + the offline-generation rule: a session runs on a pack that already exists. A pasted
  // source would need generation, so it is refused rather than quietly ignored.
  router.post("/session", async (req, res) => {
    const { topic, goal, sourceText } = req.body ?? {};
    if (typeof sourceText === "string" && sourceText.trim()) throw new SourceTextNotSupportedError();

    const { session, pack } = await createSession({ topic, goal, deps });
    const firstQuestion = nextDiagnosticQuestion(pack, session.answeredQuestionIds);
    res.status(201).json({
      sessionId: String(session._id),
      topic: pack.topic,
      packId: pack.packId,
      packStatus: pack.status,
      goal: session.goal,
      firstQuestion: firstQuestion ? publicQuestion(firstQuestion) : null,
      done: !firstQuestion,
    });
  });

  router.post("/diagnose", async (req, res) => {
    const { sessionId, questionId, answer, skip } = req.body ?? {};
    const { session, pack } = await loadSession({ sessionId, deps });
    const question = findQuestion(pack, "diagnostic", questionId);
    const isSkip = skip === true;
    if (!isSkip) requireAnswer(answer);

    const claimed = await claimQuestion({ session, questionId, skipped: isSkip, deps });
    if (!claimed) throw new QuestionAlreadyAnsweredError();

    if (!isSkip) {
      const { events } = await gradeAnswer({ question, answer, why: "", pack, deps });
      await appendEvents({ sessionId: String(session._id), pack, events, deps });
    }

    const answered = answersWith(session, questionId);
    const done = diagnosisComplete(pack, answered);
    const nextQuestion = done ? null : nextDiagnosticQuestion(pack, answered);

    res.json({
      nextQuestion: nextQuestion ? publicQuestion(nextQuestion) : null,
      done,
      evidenceCount: await deps.countEvents(String(session._id)),
      lowEvidence: Boolean(isSkip || session.skippedDiagnosis),
      answeredCount: answered.filter((id) => pack.diagnostic.some((entry) => entry.id === id)).length,
      minDiagnostic: MIN_DIAGNOSTIC,
    });
  });

  router.get("/plan/:sessionId", async (req, res) => {
    const { session, pack } = await loadSession({ sessionId: req.params.sessionId, deps });
    const events = await deps.findEvents(String(session._id));
    const plan = await buildPlan({ session, pack, events, chatJsonFn: deps.chatJson });
    res.json({
      objective: plan.objective,
      findings: plan.findings,
      steps: plan.steps,
      packStatus: pack.status,
      degraded: plan.degraded,
    });
  });

  router.post("/lesson", async (req, res) => {
    const { sessionId, stepIndex } = req.body ?? {};
    const { session, pack } = await loadSession({ sessionId, deps });
    const events = await deps.findEvents(String(session._id));
    const step = stepAt(planSteps(pack, events), stepIndex);
    const concept = pack.concepts.find((entry) => entry.id === step.conceptId);

    const lesson = await buildLesson({ pack, concept, chatJsonFn: deps.chatJson });
    res.json({
      conceptId: concept.id,
      stepIndex,
      markdown: lesson.markdown,
      citations: lesson.citations,
      trace: lesson.trace,
      workedExample: lesson.workedExample,
      degraded: lesson.degraded,
    });
  });

  router.post("/check", async (req, res) => {
    const { sessionId, questionId, answer, why } = req.body ?? {};
    const { session, pack } = await loadSession({ sessionId, deps });

    // Fetch mode: with no questionId the route only says what to ask next. The client needs this
    // once, after the diagnostic ends, because nothing else may hand out a check question.
    if (questionId === undefined || questionId === null) {
      const answered = session.answeredQuestionIds || [];
      const first = nextCheckQuestion(pack, answered);
      res.json({
        correct: null,
        feedback: null,
        nextQuestion: first ? publicQuestion(first) : null,
        checkComplete: checkComplete(pack, answered),
        degraded: false,
      });
      return;
    }

    const question = findQuestion(pack, "check", questionId);

    requireAnswer(answer);
    const explanation = typeof why === "string" ? why : "";

    const claimed = await claimQuestion({ session, questionId, deps });
    if (!claimed) throw new QuestionAlreadyAnsweredError();

    const graded = await gradeAnswer({ question, answer, why: explanation, pack, deps });
    const feedback = await writeFeedback({
      question,
      answer,
      why: explanation,
      correct: graded.correct,
      chatJsonFn: deps.chatJson,
    });

    const events = feedback.whyEvent ? [...graded.events, feedback.whyEvent] : graded.events;
    await appendEvents({ sessionId: String(session._id), pack, events, deps });

    const answered = answersWith(session, questionId);
    const complete = checkComplete(pack, answered);
    const nextQuestion = complete ? null : nextCheckQuestion(pack, answered);

    res.json({
      correct: graded.correct,
      feedback: feedback.feedback,
      nextQuestion: nextQuestion ? publicQuestion(nextQuestion) : null,
      checkComplete: complete,
      degraded: graded.degraded || feedback.degraded,
    });
  });

  router.get("/model/:sessionId", async (req, res) => {
    const { session, pack } = await loadSession({ sessionId: req.params.sessionId, deps });
    const events = await deps.findEvents(String(session._id));
    const estimates = computeEstimate(events, pack.concepts, pack.status);

    res.json({
      concepts: estimates.map((estimate) => {
        const concept = pack.concepts.find((entry) => entry.id === estimate.conceptId);
        return {
          id: estimate.conceptId,
          name: concept.name,
          status: estimate.status,
          confidence: estimate.confidence,
          eventCount: estimate.eventCount,
          // "unknown" is unassessed, never a weakness: it comes with no notes.
          notes: events
            .filter((event) => String(event.conceptId) === estimate.conceptId && event.note)
            .slice(-3)
            .map((event) => event.note),
        };
      }),
      lowEvidence: Boolean(session.skippedDiagnosis),
    });
  });

  return router;
}

module.exports = { createRouter };
