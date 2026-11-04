// The plan: what the evidence says, and in what order to work through the topic.
//
// The ORDER and the MEMBERSHIP of the plan are decided in code from the pack's prerequisite graph
// and the derived estimate. The LLM may only supply wording: an objective sentence, a `why` per
// finding and a `reason` per step. It never decides a status, a confidence, or a step order, and a
// reply that names concepts outside the plan is ignored for those concepts (the code's own text is
// used instead).
//
// No topic content lives here: concept names and descriptions come from the pack.

const { z } = require("zod");
const { chatJson } = require("../llm");
const { computeEstimate } = require("../models/models");
const { DATA_NOTICE, asData } = require("../data-tags");
const { certaintyFor } = require("./session");

// A plan a student can actually work through in one sitting.
const MAX_STEPS = 5;

const PLAN_SYSTEM = [
  "You explain a study plan to a college student. Reply with one JSON object and nothing else: no prose, no markdown fences.",
  DATA_NOTICE,
  "Rules:",
  "- You are given findings that were already computed. Describe them; never change or contradict them.",
  "- objective is one sentence about what this student should be able to do after the plan, aimed at the stated goal.",
  "- why explains what the recorded evidence does and does not show, in under 20 words.",
  "- reason says why this step comes at this point in the order, in under 20 words.",
  '- When you describe a likely gap, say "may" or "could"; never state what the student does not understand.',
  "- Use only the concept ids you are given, spelled exactly as given.",
].join("\n");

// Every field is optional: a partial reply is still useful, and the code fills the rest.
const planTextSchema = z.object({
  objective: z.string().min(1).max(400).optional(),
  findings: z
    .array(z.object({ conceptId: z.string().min(1).max(80), why: z.string().min(1).max(300) }))
    .max(20)
    .optional(),
  steps: z
    .array(z.object({ conceptId: z.string().min(1).max(80), reason: z.string().min(1).max(300) }))
    .max(20)
    .optional(),
});

const QUALITY_WORDS = {
  code_keyed: "checked against the pack's answer key",
  llm_keyed: "checked against a key the model wrote",
  llm_graded: "judged by the model",
};

// Topic-free wording, so it reads correctly for any subject.
function fallbackWhy(estimate) {
  const quality = QUALITY_WORDS[estimate.evidenceQuality];
  const suffix = quality ? `, ${quality}` : "";
  switch (estimate.status) {
    case "unknown":
      return "No answers yet.";
    case "self_reported":
      return "Only the student's own report so far.";
    case "demonstrated":
      return estimate.evidenceQuality === "code_keyed"
        ? `At least two correct answers${suffix}.`
        : `At least two correct answers${suffix}, so this is likely solid.`;
    default:
      return `Some evidence, not yet two correct answers${suffix}.`;
  }
}

function fallbackReason(concept) {
  if (!concept.prerequisites.length) return "Nothing earlier in the graph is needed first.";
  return "Builds on earlier concepts in the graph.";
}

// Prerequisites first, and otherwise the pack's own order, so two calls with the same pack give
// the same plan. The loader rejects cycles, so this always terminates.
function orderByPrerequisites(concepts) {
  const byId = new Map(concepts.map((concept) => [concept.id, concept]));
  const seen = new Set();
  const order = [];

  function visit(concept) {
    if (!concept || seen.has(concept.id)) return;
    seen.add(concept.id);
    for (const prerequisite of concept.prerequisites) visit(byId.get(prerequisite));
    order.push(concept);
  }

  for (const concept of concepts) visit(concept);
  return order;
}

function planMessages({ session, pack, findings, steps }) {
  const lines = [
    `<topic>${asData(pack.topic)}</topic>`,
    `<goal>${asData(session.goal || "not stated")}</goal>`,
    "",
    "Findings (already computed):",
    ...findings.map(
      (finding) =>
        `- conceptId="${asData(finding.conceptId)}" status=${finding.status} confidence=${finding.confidence}`
    ),
    "",
    "Plan steps, in this order:",
    ...steps.map((step, index) => `${index + 1}. conceptId="${asData(step.conceptId)}"`),
  ];
  if (!steps.length) lines.push("(none: every concept already has enough evidence)");
  lines.push(
    "",
    'Return: {"objective":"one sentence","findings":[{"conceptId":"...","why":"..."}],"steps":[{"conceptId":"...","reason":"..."}]}'
  );
  return [
    { role: "system", content: PLAN_SYSTEM },
    { role: "user", content: lines.join("\n") },
  ];
}

// Maps a reply onto the code's own order, ignoring ids the plan does not contain.
function textById(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    const text = String(entry.why ?? entry.reason ?? "")
      .trim()
      .replace(/\s+/g, " ");
    if (text) map.set(entry.conceptId, text);
  }
  return map;
}

// What the evidence says, one entry per pack concept, in the pack's own order. Pure: no LLM, no
// database. `certainty` carries A4 to the client so it never has to work the rule out itself.
function planFindings(pack, events = []) {
  const estimates = computeEstimate(events, pack.concepts, pack.status);
  const byId = new Map(estimates.map((estimate) => [estimate.conceptId, estimate]));
  return pack.concepts.map((concept) => {
    const estimate = byId.get(concept.id);
    return {
      conceptId: concept.id,
      status: estimate.status,
      confidence: estimate.confidence,
      eventCount: estimate.eventCount,
      certainty: certaintyFor(pack.status, estimate),
      why: fallbackWhy(estimate),
    };
  });
}

// Which concepts to work on, in which order. Prerequisites come first and an unmet concept is
// included whether or not its prerequisites are: the reason text can point at the weaker one.
function planSteps(pack, events = []) {
  const estimates = computeEstimate(events, pack.concepts, pack.status);
  const byId = new Map(estimates.map((estimate) => [estimate.conceptId, estimate]));
  return orderByPrerequisites(pack.concepts)
    .filter((concept) => byId.get(concept.id).status !== "demonstrated")
    .slice(0, MAX_STEPS)
    .map((concept) => ({
      conceptId: concept.id,
      title: concept.name,
      description: concept.description,
      prerequisites: concept.prerequisites,
      reason: fallbackReason(concept),
    }));
}

class StepNotFoundError extends Error {
  constructor() {
    super("That step is not part of this plan.");
    this.name = "StepNotFoundError";
    this.status = 400;
    this.code = "step_not_found";
    this.expose = true;
  }
}

// The plan is recomputed from evidence on every request rather than stored, so a step is addressed
// by position. Order is decided in code, so the same position keeps meaning the same concept
// unless the student answers something in between.
function stepAt(steps, index) {
  if (!Number.isInteger(index) || index < 0 || index >= steps.length) throw new StepNotFoundError();
  return steps[index];
}

async function buildPlan({ session, pack, events = [], chatJsonFn = chatJson } = {}) {
  const findings = planFindings(pack, events);
  const steps = planSteps(pack, events);

  const fallbackObjective =
    steps.length === 0
      ? "Review the topic, then take the check."
      : `Work through ${steps.length} step${steps.length === 1 ? "" : "s"} in order, then take the check.`;

  // Thinking is off: this call writes two sentences from data it is given, and the order it
  // describes was decided in code.
  const result = await chatJsonFn(
    planMessages({ session, pack, findings, steps }),
    planTextSchema,
    {},
    { json: true, reasoning: "off", maxTokens: 600 }
  );

  const replies = result.degraded ? {} : result.value;
  const whyById = textById(replies.findings);
  const reasonById = textById(replies.steps);

  return {
    objective:
      String(replies.objective ?? "")
        .trim()
        .replace(/\s+/g, " ") || fallbackObjective,
    findings: findings.map((finding) => ({
      ...finding,
      why: whyById.get(finding.conceptId) || finding.why,
    })),
    steps: steps.map((step) => ({ ...step, reason: reasonById.get(step.conceptId) || step.reason })),
    degraded: result.degraded === true,
  };
}

module.exports = {
  MAX_STEPS,
  buildPlan,
  planFindings,
  planSteps,
  orderByPrerequisites,
  stepAt,
  StepNotFoundError,
  fallbackWhy,
  planTextSchema,
};
