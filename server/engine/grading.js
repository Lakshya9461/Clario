// Grading and evidence for one answered question.
//
// Two graders, and the contract decides which one runs:
//   - a question with an answer key is graded in CODE (exact match). The model never decides it.
//   - a question with only a rubric is graded by the LLM, which PROPOSES evidence events; the
//     server validates them against the pack's concepts before anything is written.
// Rule: the LLM never writes an estimate, and evidence is only ever appended.

const { z } = require("zod");
const { chatJson } = require("../llm");
const { DATA_NOTICE, asData } = require("../data-tags");

// Grading text is engine text: no subject words, only the shape of an answer.
const GRADE_SYSTEM = [
  "You grade a short written answer for a study app. Reply with one JSON object and nothing else: no prose, no markdown fences.",
  DATA_NOTICE,
  "Rules:",
  "- Judge the answer against the supplied rubric, not against its length.",
  '- outcome is "correct" (meets the rubric), "partial" (some of it) or "incorrect".',
  "- Report only concept ids from the supplied list, at most one entry each.",
  "- note is under 25 words. When you describe a likely mistake, say \"may\" or \"could\"; never state what the student does not understand.",
].join("\n");

const FEEDBACK_SYSTEM = [
  "You write feedback on one answer for a study app. Reply with one JSON object and nothing else: no prose, no markdown fences.",
  DATA_NOTICE,
  "Rules:",
  "- feedback is one or two short sentences, addressed to the student, about this answer only.",
  "- When you describe a likely mistake, say \"may\" or \"could\"; never state what the student does not understand.",
  "- If an explanation was expected and the student did not give one, say that it was not given.",
  "- Do not reveal the answer key of any other question and do not invent new questions.",
].join("\n");

const gradeResponseSchema = z.object({
  concepts: z
    .array(
      z.object({
        conceptId: z.string().min(1).max(80),
        outcome: z.enum(["correct", "partial", "incorrect"]),
        note: z.string().min(1).max(300),
      })
    )
    .min(1)
    .max(3),
});

const feedbackResponseSchema = z.object({
  feedback: z.string().min(1).max(400),
  whyOutcome: z.enum(["correct", "partial", "incorrect"]).nullish(),
  whyNote: z.string().max(300).nullish(),
});

function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

// Returns { outcome: "correct" | "incorrect" } when the pack's key can decide the answer, or null
// when it cannot (a free_text question, or a key type this engine does not know).
function gradeKeyed(question, answer) {
  const key = question.answerKey;
  if (!key) return null;

  if (key.type === "option") {
    const options = question.options || [];
    const text = normalizeText(answer);

    // The client may send the option text (what the pack keys on) or its position.
    const chosen = options.includes(text)
      ? text
      : Number.isInteger(Number(answer)) && options[Number(answer)] !== undefined
        ? options[Number(answer)]
        : null;

    if (chosen === null) return { outcome: "incorrect" }; // not one of the options cannot be right
    return { outcome: chosen === normalizeText(key.value) ? "correct" : "incorrect" };
  }

  if (key.type === "tokens") {
    const want = key.value.map(normalizeText);
    const got = normalizeText(answer).split(" ").filter(Boolean);
    const same = want.length === got.length && want.every((token, index) => token === got[index]);
    return { outcome: same ? "correct" : "incorrect" };
  }

  return null;
}

// A4: a curated key is the strongest evidence available; a generated pack's key was written by
// the model, so the same code grade is worth less.
function keyedQuality(packStatus) {
  return packStatus === "curated" ? "code_keyed" : "llm_keyed";
}

// Says what happened, not what it means. No claim about the student's understanding is ever
// derived in code.
function keyedNote(question, outcome) {
  const how = outcome === "correct" ? "correctly" : "incorrectly";
  return `Answered a difficulty-${question.difficulty} ${question.kind} question ${how}.`;
}

function keyedEvents({ question, outcome, packStatus }) {
  return question.conceptIds.map((conceptId) => ({
    conceptId,
    questionId: question.id,
    evidenceType: "demonstrated",
    gradedBy: "code",
    evidenceQuality: keyedQuality(packStatus),
    outcome,
    note: keyedNote(question, outcome),
  }));
}

// A self-report question asks the student to rate themselves. It has no key and no rubric, so
// there is nothing to grade: what the student says is evidence of what they CLAIM, and the model
// must not be asked to turn it into a demonstration. The pack may mark one with "selfReport": true;
// a question with neither an answer key nor a rubric is one in effect, because there is nothing
// else it could be graded against.
function isSelfReport(question) {
  return question.selfReport === true || (!question.answerKey && !question.rubric);
}

// The options are a scale, so the claim is read by position, never by wording: the bottom of the
// scale is "unsure" and any higher option is the student saying they have it. An answer that is not
// one of the options cannot be read as a claim either way, so it is "unsure" too.
function selfReportOutcome(question, answer) {
  const options = question.options || [];
  const text = normalizeText(answer);
  const byText = options.findIndex((option) => normalizeText(option) === text);
  const byPosition = text !== "" && Number.isInteger(Number(answer)) ? Number(answer) : -1;
  const position = byText >= 0 ? byText : byPosition;
  return position > 0 && position < options.length ? "correct" : "unsure";
}

const SELF_REPORT_NOTE = {
  correct: "Student rated their own grasp of this as confident.",
  unsure: "Student rated their own grasp of this as unsure.",
};

// Never a demonstration, never a quality: the student's own claim, recorded as such.
function selfReportEvents({ question, answer }) {
  const outcome = selfReportOutcome(question, answer);
  return question.conceptIds.map((conceptId) => ({
    conceptId,
    questionId: question.id,
    evidenceType: "self_report",
    gradedBy: "student",
    evidenceQuality: null,
    outcome,
    note: SELF_REPORT_NOTE[outcome],
  }));
}

// A graded answer gets the pack's own wording when the model is unavailable; a self-report is not
// graded at all, so it says what was recorded instead of pretending to mark it.
const SELF_REPORT_FEEDBACK =
  "Recorded as your own rating. It is kept apart from what you demonstrate, so it never counts as a correct answer.";

function gradeMessages({ question, answer, why }) {
  const lines = [
    `<question>${asData(question.prompt)}</question>`,
    `<rubric>${asData(question.rubric || "Full credit if the answer is correct and complete.")}</rubric>`,
    `<student_answer>${asData(answer)}</student_answer>`,
  ];
  if (why) lines.push(`<why>${asData(why)}</why>`);
  lines.push(
    "",
    `Concept ids for this question: ${question.conceptIds.map((id) => asData(id)).join(", ")}`,
    'Return: {"concepts":[{"conceptId":"id_from_the_list","outcome":"correct|partial|incorrect","note":"under 25 words"}]}'
  );
  return [
    { role: "system", content: GRADE_SYSTEM },
    { role: "user", content: lines.join("\n") },
  ];
}

// Proposes evidence events for a written answer. null means "do not record anything": either the
// model could not be reached or it named concepts this question is not about, and inventing
// evidence is worse than recording none.
async function gradeWritten({ question, answer, why, chatJsonFn = chatJson }) {
  const result = await chatJsonFn(gradeMessages({ question, answer, why }), gradeResponseSchema, {
    concepts: [],
  }, { json: true, reasoning: "off", maxTokens: 300 });

  if (result.degraded) return { events: null, degraded: true };

  const allowed = new Set(question.conceptIds);
  const entries = result.value.concepts.filter((entry) => allowed.has(entry.conceptId));
  if (!entries.length) return { events: null, degraded: false };

  const events = entries.map((entry) => ({
    conceptId: entry.conceptId,
    questionId: question.id,
    // "correct" is a demonstration; anything less is an inference about where to look next.
    evidenceType: entry.outcome === "correct" ? "demonstrated" : "inferred",
    gradedBy: "llm",
    evidenceQuality: "llm_graded",
    outcome: entry.outcome,
    note: entry.note,
  }));
  return { events, degraded: false };
}

function feedbackMessages({ question, answer, why, correct }) {
  const lines = [
    `<question>${asData(question.prompt)}</question>`,
    `<student_answer>${asData(answer)}</student_answer>`,
    `The answer was graded ${correct ? "correct" : "not correct"}.`,
  ];
  if (question.requiresWhy) {
    lines.push(
      why
        ? `<why>${asData(why)}</why>\nDid that explanation show the reasoning, or only restate the answer? Judge it as "correct", "partial" or "incorrect" and put it in whyOutcome, with a short whyNote.`
        : "The question asked for a short explanation and none was given. Say so, and leave whyOutcome null."
    );
  }
  lines.push(
    "",
    'Return: {"feedback":"one or two sentences","whyOutcome":"correct|partial|incorrect|null","whyNote":"under 25 words"}'
  );
  return [
    { role: "system", content: FEEDBACK_SYSTEM },
    { role: "user", content: lines.join("\n") },
  ];
}

// Student-facing feedback, plus an inference when an explanation had to be judged. The pack's own
// fallback text is used when the model is unavailable, so the student always gets an answer.
async function writeFeedback({ question, answer, why = "", correct, chatJsonFn = chatJson }) {
  const fallback = correct
    ? question.fallbackFeedback.correct
    : question.fallbackFeedback.incorrect;

  const result = await chatJsonFn(
    feedbackMessages({ question, answer, why, correct }),
    feedbackResponseSchema,
    { feedback: fallback, whyOutcome: null, whyNote: null },
    { json: true, reasoning: "off", maxTokens: 300 }
  );

  const feedback = normalizeText(result.value.feedback) || fallback;
  const whyOutcome = question.requiresWhy ? result.value.whyOutcome ?? null : null;

  const whyEvent =
    whyOutcome && question.conceptIds.length
      ? {
          conceptId: question.conceptIds[0],
          questionId: question.id,
          evidenceType: whyOutcome === "correct" ? "demonstrated" : "inferred",
          gradedBy: "llm",
          evidenceQuality: "llm_graded",
          outcome: whyOutcome,
          note:
            normalizeText(result.value.whyNote).slice(0, 300) ||
            `Explanation judged ${whyOutcome}.`,
        }
      : null;

  return { feedback, whyEvent, degraded: result.degraded === true };
}

module.exports = {
  gradeKeyed,
  keyedQuality,
  keyedEvents,
  keyedNote,
  gradeWritten,
  writeFeedback,
  gradeResponseSchema,
  normalizeText,
  isSelfReport,
  selfReportOutcome,
  selfReportEvents,
  SELF_REPORT_FEEDBACK,
};
