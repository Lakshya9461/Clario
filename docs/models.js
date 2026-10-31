// Mongoose models and the derived-estimate function for the Clario beta.
// Rules:
//  - evidenceEvents are APPEND-ONLY. Never update or delete them (except tester-data teardown).
//  - The per-concept estimate is DERIVED by computeEstimate(); it is never stored.
//  - The LLM may only PROPOSE evidence events (validated by the server); it never writes an estimate.

const mongoose = require("mongoose");

const sessionSchema = new mongoose.Schema({
  topic: { type: String, default: "python-recursion" },
  createdAt: { type: Date, default: Date.now },
  skippedDiagnosis: { type: Boolean, default: false },
  goal: { type: String, default: "" }, // course | assignment | exam | curiosity (from the entry question)
});

const evidenceEventSchema = new mongoose.Schema({
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "Session", index: true, required: true },
  conceptId: { type: String, required: true },        // must exist in concepts.json
  questionId: { type: String, default: null },        // id from questions.json, null for free chat
  evidenceType: { type: String, enum: ["self_report", "demonstrated", "inferred"], required: true },
  gradedBy: { type: String, enum: ["code", "llm", "student"], required: true },
  outcome: { type: String, enum: ["correct", "incorrect", "partial", "unsure"], required: true },
  note: { type: String, default: "", maxlength: 300 }, // short human-readable reason, shown in the learner view
  createdAt: { type: Date, default: Date.now },
});

// Provisional beta rule. Change freely: nothing is migrated because estimates are derived.
//   status:
//     "unknown"       no events
//     "self_reported" only self_report events
//     "demonstrated"  >= 2 demonstrated-correct events (at least one graded by code) and the latest demonstrated event is not incorrect
//     "developing"    anything else with at least one demonstrated/inferred event
//   confidence: "low" (< 2 events), "moderate" (2-3), "high" (>= 4 and consistent)
function computeEstimate(events) {
  if (!events.length) return { status: "unknown", confidence: "none", eventCount: 0 };
  const demo = events.filter((e) => e.evidenceType === "demonstrated");
  const other = events.filter((e) => e.evidenceType === "inferred");
  if (!demo.length && !other.length) {
    return { status: "self_reported", confidence: "low", eventCount: events.length };
  }
  const correct = demo.filter((e) => e.outcome === "correct");
  const hasCodeGraded = correct.some((e) => e.gradedBy === "code");
  const latestDemo = [...demo].sort((a, b) => b.createdAt - a.createdAt)[0];
  const isDemonstrated =
    correct.length >= 2 && hasCodeGraded && latestDemo && latestDemo.outcome !== "incorrect";
  const n = demo.length + other.length;
  const consistent = demo.every((e) => e.outcome === demo[0].outcome);
  return {
    status: isDemonstrated ? "demonstrated" : "developing",
    confidence: n >= 4 && consistent ? "high" : n >= 2 ? "moderate" : "low",
    eventCount: events.length,
  };
}

module.exports = {
  Session: mongoose.model("Session", sessionSchema),
  EvidenceEvent: mongoose.model("EvidenceEvent", evidenceEventSchema),
  computeEstimate,
};
