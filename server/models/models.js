// Mongoose models and the derived-estimate function for the Clario beta.
// Rules:
//  - evidenceEvents are APPEND-ONLY. Never update or delete them (except tester-data teardown).
//  - The per-concept estimate is DERIVED by computeEstimate(); it is never stored.
//  - The LLM may only PROPOSE evidence events (validated by the server); it never writes an estimate.
//  - This file holds NO topic content. Topics live in packs (server/packs/).

const mongoose = require("mongoose");

const sessionSchema = new mongoose.Schema({
  // The student's topic as entered. Matched case-insensitively against pack.topic.
  topic: { type: String, required: true },
  // The pack this session is running on, and where it came from. packStatus is stored
  // (not re-derived) because A4's "demonstrated" rule differs for curated vs generated
  // packs, and a session's provenance must not change under it if a pack is later promoted.
  packId: { type: String, required: true },
  packStatus: { type: String, enum: ["curated", "generated"], required: true },
  createdAt: { type: Date, default: Date.now },
  skippedDiagnosis: { type: Boolean, default: false },
  // Which questions the student has answered or skipped. One field, because a skipped question
  // leaves no evidence behind yet must not be asked again: the claim is what records it, and the
  // atomic claim is also what stops a double submit from being graded twice.
  answeredQuestionIds: { type: [String], default: [] },
  goal: { type: String, default: "" }, // course | assignment | exam | curiosity (from the entry question)
});

const evidenceEventSchema = new mongoose.Schema({
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "Session", index: true, required: true },
  conceptId: { type: String, required: true },        // must exist in the session's pack concepts
  questionId: { type: String, default: null },        // id from the pack, null for free chat
  evidenceType: { type: String, enum: ["self_report", "demonstrated", "inferred"], required: true },
  gradedBy: { type: String, enum: ["code", "llm", "student"], required: true },
  // A4. How much the evidence is worth:
  //   code_keyed  answer key was curated and graded in code
  //   llm_keyed   answer key was written by the LLM, still graded in code
  //   llm_graded  the LLM judged the answer (no key)
  // null for self_report events: the student's own claim carries no key at all and is
  // never counted towards "demonstrated", so it contributes no quality.
  evidenceQuality: {
    type: String,
    enum: ["code_keyed", "llm_keyed", "llm_graded", null],
    default: null,
  },
  outcome: { type: String, enum: ["correct", "incorrect", "partial", "unsure"], required: true },
  note: { type: String, default: "", maxlength: 300 }, // short human-readable reason, shown in the learner view
  createdAt: { type: Date, default: Date.now },
});

// A1: generated draft packs. Curated packs are JSON files in server/packs/ and never live
// here. The whole pack is stored as validated JSON; topicKey is the cache key, so asking
// for the same topic twice reuses one pack instead of regenerating it.
// minimize: false, because mongoose's default strips empty objects out of the Mixed pack on
// save. "traces" is required by the validator and is {} for every generated pack, so the default
// would store a pack that comes back out failing validatePack.
const packSchema = new mongoose.Schema(
  {
    topicKey: { type: String, required: true, unique: true }, // normalized topic: trimmed, collapsed, lowercase
    topic: { type: String, required: true },                  // the topic as the student asked for it
    pack: { type: mongoose.Schema.Types.Mixed, required: true }, // validated pack JSON, status "generated"
    createdAt: { type: Date, default: Date.now },
  },
  { minimize: false }
);

// Strongest first. The estimate reports the WEAKEST quality among the events it used.
const EVIDENCE_QUALITY_STRENGTH = { code_keyed: 3, llm_keyed: 2, llm_graded: 1 };

function weakestEvidenceQuality(events) {
  let weakest = null;
  for (const event of events) {
    const strength = EVIDENCE_QUALITY_STRENGTH[event.evidenceQuality];
    if (!strength) continue; // self_report and legacy events carry no quality
    if (weakest === null || strength < EVIDENCE_QUALITY_STRENGTH[weakest]) {
      weakest = event.evidenceQuality;
    }
  }
  return weakest;
}

// Provisional beta rule. Change freely: nothing is migrated because estimates are derived.
//   status:
//     "unknown"       no events
//     "self_reported" only self_report events
//     "demonstrated"  >= 2 demonstrated-correct events, and for curated packs at least one of
//                     them code_keyed, and the latest demonstrated event is not incorrect
//     "developing"    anything else with at least one demonstrated/inferred event
//   confidence: "low" (< 2 events), "moderate" (2-3), "high" (>= 4 and consistent)
//   evidenceQuality: weakest quality among the demonstrated/inferred events used, else null.
//     For generated packs status "demonstrated" always comes with "llm_keyed" or "llm_graded",
//     so the API must present it as "likely demonstrated" (A4).
function estimateForConcept(events, packStatus) {
  if (!events.length) {
    return { status: "unknown", confidence: "none", eventCount: 0, evidenceQuality: null };
  }
  const demonstrated = events.filter((e) => e.evidenceType === "demonstrated");
  const inferred = events.filter((e) => e.evidenceType === "inferred");
  const evidenceQuality = weakestEvidenceQuality([...demonstrated, ...inferred]);

  if (!demonstrated.length && !inferred.length) {
    return { status: "self_reported", confidence: "low", eventCount: events.length, evidenceQuality };
  }

  const correct = demonstrated.filter((e) => e.outcome === "correct");
  const hasCodeKeyed = correct.some((e) => e.evidenceQuality === "code_keyed");
  const latestDemo = demonstrated
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  // Curated packs need one curated key in the evidence. Generated packs have no curated
  // key to point at, so the requirement is the count plus the quality label itself.
  const meetsQuality = packStatus === "curated" ? hasCodeKeyed : true;
  const isDemonstrated =
    correct.length >= 2 && meetsQuality && latestDemo && latestDemo.outcome !== "incorrect";

  const n = demonstrated.length + inferred.length;
  const consistent = demonstrated.every((e) => e.outcome === demonstrated[0].outcome);
  return {
    status: isDemonstrated ? "demonstrated" : "developing",
    confidence: n >= 4 && consistent ? "high" : n >= 2 ? "moderate" : "low",
    eventCount: events.length,
    evidenceQuality,
  };
}

// Takes the session's concept list (from its pack) and returns one estimate per concept.
// Only listed concepts are reported; an event for a concept that is not in the pack is a
// data error the caller should have rejected, not something to surface here.
function computeEstimate(events, concepts = [], packStatus = "curated") {
  return concepts.map((concept) => ({
    conceptId: concept.id,
    ...estimateForConcept(
      events.filter((e) => String(e.conceptId) === String(concept.id)),
      packStatus
    ),
  }));
}

module.exports = {
  Session: mongoose.model("Session", sessionSchema),
  EvidenceEvent: mongoose.model("EvidenceEvent", evidenceEventSchema),
  Pack: mongoose.model("Pack", packSchema),
  computeEstimate,
};
