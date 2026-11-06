// Unit tests for the derived estimate (A4). Run with: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeEstimate, Pack } = require("./models");

const concepts = [{ id: "c1" }, { id: "c2" }];

function event(overrides = {}) {
  return {
    conceptId: "c1",
    evidenceType: "demonstrated",
    gradedBy: "code",
    evidenceQuality: "code_keyed",
    outcome: "correct",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function estimateOf(events, conceptId = "c1", packStatus = "curated") {
  return computeEstimate(events, concepts, packStatus).find((e) => e.conceptId === conceptId);
}

test("returns one estimate per concept, unknown when there are no events", () => {
  const estimates = computeEstimate([], concepts, "curated");
  assert.deepEqual(estimates, [
    { conceptId: "c1", status: "unknown", confidence: "none", eventCount: 0, evidenceQuality: null },
    { conceptId: "c2", status: "unknown", confidence: "none", eventCount: 0, evidenceQuality: null },
  ]);
});

test("a self-report alone is self_reported and carries no evidence quality", () => {
  const estimate = estimateOf([
    event({ evidenceType: "self_report", gradedBy: "student", evidenceQuality: null, outcome: "correct" }),
  ]);
  assert.equal(estimate.status, "self_reported");
  assert.equal(estimate.evidenceQuality, null);
});

test("two llm_keyed correct answers are not demonstrated in a curated pack", () => {
  const estimate = estimateOf([
    event({ evidenceQuality: "llm_keyed", gradedBy: "code" }),
    event({ evidenceQuality: "llm_keyed", gradedBy: "code" }),
  ]);
  assert.equal(estimate.status, "developing");
  assert.equal(estimate.evidenceQuality, "llm_keyed");
});

test("two correct answers, one code_keyed, are demonstrated in a curated pack", () => {
  const estimate = estimateOf([
    event(),
    event({ evidenceQuality: "llm_keyed", gradedBy: "code" }),
  ]);
  assert.equal(estimate.status, "demonstrated");
  assert.equal(estimate.evidenceQuality, "llm_keyed"); // weakest among the events used
});

test("the same events are demonstrated in a generated pack", () => {
  const estimate = estimateOf(
    [event({ evidenceQuality: "llm_keyed" }), event({ evidenceQuality: "llm_keyed" })],
    "c1",
    "generated"
  );
  assert.equal(estimate.status, "demonstrated");
  assert.equal(estimate.evidenceQuality, "llm_keyed");
});

test("a single correct answer is never demonstrated", () => {
  assert.equal(estimateOf([event()]).status, "developing");
});

test("a later incorrect answer blocks demonstrated", () => {
  const estimate = estimateOf([
    event(),
    event({ createdAt: new Date("2026-01-01T00:00:00Z") }),
    event({ outcome: "incorrect", createdAt: new Date("2026-01-02T00:00:00Z") }),
  ]);
  assert.notEqual(estimate.status, "demonstrated");
});

test("an llm_graded event lowers the reported evidence quality", () => {
  const estimate = estimateOf([
    event(),
    event(),
    event({ evidenceType: "inferred", gradedBy: "llm", evidenceQuality: "llm_graded" }),
  ]);
  assert.equal(estimate.status, "demonstrated");
  assert.equal(estimate.evidenceQuality, "llm_graded");
});

test("estimates are per concept", () => {
  const estimates = computeEstimate([event({ conceptId: "c2" })], concepts, "curated");
  assert.equal(estimates.find((e) => e.conceptId === "c1").status, "unknown");
  assert.equal(estimates.find((e) => e.conceptId === "c2").status, "developing");
});

// The pack that comes back out of Mongo is what the app serves, so it has to be the pack that
// passed the validator. "traces" is a required record and is {} for every generated pack, and
// mongoose's default minimize would strip it on save -- hence the schema option, pinned here.
test("the pack schema keeps empty objects so traces survives a save", () => {
  assert.equal(Pack.schema.options.minimize, false);
});
