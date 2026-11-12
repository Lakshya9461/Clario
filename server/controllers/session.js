// POST /session and POST /diagnose — a session's start and its diagnostic.
//
// A3 + the offline-generation rule: a session runs on a pack that already exists, so a pasted
// source is refused rather than quietly ignored (it would need generation, and a request may not
// wait minutes for that). Starting a session is the only route that creates a session document.

const {
  QuestionAlreadyAnsweredError,
  SourceTextNotSupportedError,
  claimQuestion,
  createSession,
  diagnosisComplete,
  findQuestion,
  loadSession,
  nextDiagnosticQuestion,
  publicQuestion,
  releaseQuestion,
  MIN_DIAGNOSTIC,
} = require("../engine/session");
const { answersWith, gradeAnswer, requireAnswer } = require("./answers");
const { appendEvents } = require("./evidence");

function create(deps) {
  return async function createSessionHandler(req, res) {
    const { topic, goal, sourceText } = req.body ?? {};
    if (typeof sourceText === "string" && sourceText.trim()) throw new SourceTextNotSupportedError();

    const { session, pack } = await createSession({ topic, goal, userId: req.user?.sub, deps });
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
  };
}

function diagnose(deps) {
  return async function diagnoseHandler(req, res) {
    const { sessionId, questionId, answer, skip } = req.body ?? {};
    const { session, pack } = await loadSession({
      sessionId,
      userId: req.user?.sub,
      isAdmin: req.user?.role === "admin",
      deps,
    });
    const question = findQuestion(pack, "diagnostic", questionId);
    const isSkip = skip === true;
    const answerText = isSkip ? "" : requireAnswer(answer);

    const claimed = await claimQuestion({ session, questionId, skipped: isSkip, deps });
    if (!claimed) throw new QuestionAlreadyAnsweredError();

    if (!isSkip) {
      let graded;
      try {
        graded = await gradeAnswer({ question, answer: answerText, why: "", pack, deps });
      } catch (error) {
        // Nothing was written, so the claim must go back: otherwise a busy or unreachable model
        // would leave the question answered with no evidence and the retry would be a 409.
        await releaseQuestion({ session, questionId, deps });
        throw error;
      }
      await appendEvents({ sessionId: String(session._id), pack, events: graded.events, deps });
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
  };
}

module.exports = { create, diagnose };
