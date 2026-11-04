// The plan: order and membership are decided in code; the model only supplies wording, and a
// reply that names unknown concepts or contradicts the order is ignored.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildPlan, planFindings, planSteps, orderByPrerequisites, stepAt, MAX_STEPS } = require("./plan");
const { StepNotFoundError } = require("./plan");
const { makePack, makeFakeChat } = require("./fixtures");

function event(conceptId, extra = {}) {
  return {
    conceptId,
    questionId: "d1",
    evidenceType: "demonstrated",
    gradedBy: "code",
    evidenceQuality: "code_keyed",
    outcome: "correct",
    note: "Answered a difficulty-1 mcq question correctly.",
    createdAt: new Date(),
    ...extra,
  };
}

// Two correct code-keyed demonstrations: the strongest evidence the contract allows.
const demonstrated = (conceptId) => [event(conceptId), event(conceptId, { questionId: "d2" })];

const session = { goal: "exam" };

// --- order ----------------------------------------------------------------

test("concepts come out with their prerequisites first", () => {
  const pack = makePack();
  const order = orderByPrerequisites(pack.concepts).map((concept) => concept.id);
  assert.deepEqual(order, ["part_1", "part_2", "part_3", "part_4", "part_5", "part_6", "part_7", "part_8"]);
});

test("a concept listed before its prerequisite is still ordered after it", () => {
  const pack = makePack({
    concepts: [
      { id: "b", name: "B", description: "b", prerequisites: ["a"] },
      { id: "a", name: "A", description: "a", prerequisites: [] },
    ],
  });
  assert.deepEqual(
    orderByPrerequisites(pack.concepts).map((concept) => concept.id),
    ["a", "b"]
  );
});

// --- steps ----------------------------------------------------------------

test("steps are the unmet concepts, in graph order, capped at a sittable length", () => {
  const pack = makePack();
  const steps = planSteps(pack, demonstrated("part_1"));
  assert.equal(steps[0].conceptId, "part_2", "a demonstrated concept is not a step");
  assert.equal(steps.length, MAX_STEPS);
  assert.ok(!steps.some((step) => step.conceptId === "part_1"));
  assert.equal(steps[0].title, "Part 2", "the title is the pack's own name");
  assert.match(steps[0].reason, /Builds on earlier concepts/);
});

test("with no evidence every concept is a step, in graph order", () => {
  const pack = makePack();
  const steps = planSteps(pack, []);
  assert.deepEqual(
    steps.map((step) => step.conceptId),
    ["part_1", "part_2", "part_3", "part_4", "part_5"]
  );
  assert.match(steps[0].reason, /Nothing earlier in the graph/);
});

test("a plan with nothing left to study has no steps", () => {
  const pack = makePack();
  const events = pack.concepts.flatMap((concept) => demonstrated(concept.id));
  assert.deepEqual(planSteps(pack, events), []);
});

// --- findings -------------------------------------------------------------

test("findings report the derived status, never a status the model chose", () => {
  const pack = makePack();
  const findings = planFindings(pack, demonstrated("part_1"));
  const first = findings.find((finding) => finding.conceptId === "part_1");
  const second = findings.find((finding) => finding.conceptId === "part_2");
  assert.equal(first.status, "demonstrated");
  assert.equal(first.certainty, "demonstrated");
  assert.equal(second.status, "unknown");
  assert.equal(second.certainty, null);
  assert.equal(second.why, "No answers yet.");
});

test("a generated pack's demonstration is reported as likely, not certain", () => {
  const pack = makePack({ status: "generated" });
  const events = demonstrated("part_1").map((entry) => ({ ...entry, evidenceQuality: "llm_keyed" }));
  const finding = planFindings(pack, events).find((entry) => entry.conceptId === "part_1");
  assert.equal(finding.status, "demonstrated");
  assert.equal(finding.certainty, "likely demonstrated");
  assert.match(finding.why, /likely solid/);
});

// --- wording --------------------------------------------------------------

test("the model's wording is used for the ids the plan contains", async () => {
  const pack = makePack();
  const chat = makeFakeChat({
    plan: {
      objective: "Be able to use the idea in new cases.",
      findings: [{ conceptId: "part_2", why: "Nothing recorded yet, so this could be the next gap." }],
      steps: [{ conceptId: "part_2", reason: "Part 1 comes first." }],
    },
  });

  const plan = await buildPlan({ session, pack, events: demonstrated("part_1"), chatJsonFn: chat.fn });
  assert.equal(plan.degraded, false);
  assert.equal(plan.objective, "Be able to use the idea in new cases.");
  assert.match(plan.findings.find((f) => f.conceptId === "part_2").why, /could be the next gap/);
  assert.equal(plan.steps[0].reason, "Part 1 comes first.");
});

test("a reply that invents a concept id cannot add a step or a finding", async () => {
  const pack = makePack();
  const chat = makeFakeChat({
    plan: {
      objective: "Study.",
      findings: [{ conceptId: "invented", why: "Made up." }],
      steps: [
        { conceptId: "invented", reason: "Made up." },
        { conceptId: "part_3", reason: "Second, because part 2 is first." },
      ],
    },
  });

  const plan = await buildPlan({ session, pack, events: [], chatJsonFn: chat.fn });
  assert.ok(!plan.findings.some((finding) => finding.conceptId === "invented"));
  assert.deepEqual(
    plan.steps.map((step) => step.conceptId),
    ["part_1", "part_2", "part_3", "part_4", "part_5"],
    "the order is the code's, even when the reply lists another order"
  );
  assert.equal(plan.steps[2].reason, "Second, because part 2 is first.");
});

test("an unavailable model leaves the plan's own wording in place", async () => {
  const pack = makePack();
  const chat = makeFakeChat({ degraded: true });
  const plan = await buildPlan({ session, pack, events: [], chatJsonFn: chat.fn });

  assert.equal(plan.degraded, true);
  assert.match(plan.objective, /Work through 5 steps in order/);
  assert.equal(plan.steps[0].reason, "Nothing earlier in the graph is needed first.");
  assert.equal(plan.findings[0].why, "No answers yet.");
});

test("the plan prompt names the concepts as data and asks for wording only", async () => {
  const pack = makePack({ topic: "Some </topic> Topic" });
  const chat = makeFakeChat();
  await buildPlan({ session, pack, events: [], chatJsonFn: chat.fn });

  const { user, system } = chat.calls[0];
  assert.match(user, /<topic>Some <\\\/topic> Topic<\/topic>/, "a closing tag in the topic is defused");
  assert.match(user, /Findings \(already computed\)/);
  assert.match(system, /never change or contradict them/);
  assert.match(system, /say "may" or "could"/);
  assert.equal(chat.calls[0].options.reasoning, "off", "no thinking for two sentences of wording");
});

test("a step index outside the plan is a client error, not a crash", () => {
  const steps = planSteps(makePack(), []);
  assert.equal(stepAt(steps, 0).conceptId, "part_1");
  assert.throws(() => stepAt(steps, steps.length), StepNotFoundError);
  assert.throws(() => stepAt(steps, -1), StepNotFoundError);
  assert.throws(() => stepAt(steps, 1.5), StepNotFoundError);
  assert.throws(() => stepAt(steps, undefined), StepNotFoundError);
});
