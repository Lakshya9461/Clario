// The answer path shared by /diagnose and /check: what the request's text may be, and what it turns
// into. Every student answer goes through here before it can reach a prompt or the evidence log.

const {
  AnswerTooLongError,
  InvalidAnswerError,
  MAX_ANSWER_LENGTH,
} = require("../engine/session");
const {
  gradeKeyed,
  gradeWritten,
  keyedEvents,
  isSelfReport,
  selfReportEvents,
} = require("../engine/grading");

// Student text that goes into a prompt is bounded here, at the trust boundary. The answer is
// required; the explanation is optional and shares the same cap.
function boundedText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > MAX_ANSWER_LENGTH) throw new AnswerTooLongError();
  return text;
}

function requireAnswer(answer) {
  const text = boundedText(answer);
  if (!text) throw new InvalidAnswerError();
  return text;
}

// The loaded session is a snapshot taken before the claim, so the id just claimed is added here.
// A Set because counting the same id twice would end a 3-question diagnostic after two answers.
function answersWith(session, questionId) {
  return Array.from(new Set([...(session.answeredQuestionIds || []), questionId]));
}

// A keyed question is graded in code, exactly. A self-report question is not graded at all: the
// student's own rating is recorded as a claim. Everything else is graded by the model, which may
// only propose evidence; a failed grading records nothing rather than inventing it.
async function gradeAnswer({ question, answer, why, pack, deps }) {
  if (isSelfReport(question)) {
    return {
      correct: null,
      selfReport: true,
      events: selfReportEvents({ question, answer }),
      degraded: false,
    };
  }

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

module.exports = { boundedText, requireAnswer, answersWith, gradeAnswer };
