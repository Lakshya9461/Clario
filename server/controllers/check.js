// POST /check — two modes on one route.
//
// Fetch mode (no questionId) only says what to ask next: the client needs it once, after the
// diagnostic ends, because nothing else may hand out a check question.
//
// Answer mode claims the question first (a double submit is a 409, never graded twice), grades it,
// writes one feedback, and returns the next question. A failed model call releases the claim so the
// student can retry the same answer instead of finding it already answered.

const {
  QuestionAlreadyAnsweredError,
  checkComplete,
  claimQuestion,
  findQuestion,
  loadSession,
  nextCheckQuestion,
  publicQuestion,
  releaseQuestion,
} = require("../engine/session");
const { writeFeedback, SELF_REPORT_FEEDBACK } = require("../engine/grading");
const { answersWith, boundedText, gradeAnswer, requireAnswer } = require("./answers");
const { appendEvents } = require("./evidence");

function read(deps) {
  return async function checkAnswer(req, res) {
    const { sessionId, questionId, answer, why } = req.body ?? {};
    const { session, pack } = await loadSession({ sessionId, deps });

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

    const answerText = requireAnswer(answer);
    const explanation = boundedText(why);

    const claimed = await claimQuestion({ session, questionId, deps });
    if (!claimed) throw new QuestionAlreadyAnsweredError();

    let graded;
    let feedback;
    try {
      graded = await gradeAnswer({ question, answer: answerText, why: explanation, pack, deps });
      // A self-report is not graded, so its feedback is engine text, not a model call.
      feedback = graded.selfReport
        ? { feedback: SELF_REPORT_FEEDBACK, whyEvent: null, degraded: false }
        : await writeFeedback({
            question,
            answer: answerText,
            why: explanation,
            correct: graded.correct,
            chatJsonFn: deps.chatJson,
          });
    } catch (error) {
      await releaseQuestion({ session, questionId, deps });
      throw error;
    }

    const events = feedback.whyEvent ? [...graded.events, feedback.whyEvent] : graded.events;
    await appendEvents({ sessionId: String(session._id), pack, events, deps });

    const answered = answersWith(session, questionId);
    const complete = checkComplete(pack, answered);
    const nextQuestion = complete ? null : nextCheckQuestion(pack, answered);

    res.json({
      correct: graded.correct,
      selfReport: graded.selfReport === true,
      feedback: feedback.feedback,
      nextQuestion: nextQuestion ? publicQuestion(nextQuestion) : null,
      checkComplete: complete,
      degraded: graded.degraded || feedback.degraded,
    });
  };
}

module.exports = { read };
