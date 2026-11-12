// The arithmetic behind the admin dashboard, checked without a database: a day is a UTC day, a zero
// day is a real row in the chart, every quality label is always present, and a concept's bucket
// follows the documented rule. These functions are pure so they can be tested exactly here.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  isoDay,
  last30Days,
  fillDaySeries,
  qualityCounts,
  classifyOutcomes,
  topTopic,
} = require("./analytics");

test("the last 30 days are 30 UTC days, oldest first, ending today", () => {
  const now = new Date(Date.UTC(2026, 10, 12, 15, 0, 0)); // 2026-11-12
  const days = last30Days(now);
  assert.equal(days.length, 30);
  assert.equal(days[0], "2026-10-14");
  assert.equal(days[29], "2026-11-12");
  assert.deepEqual(days, [...days].sort());
});

test("a day is written exactly as the pipeline writes it", () => {
  assert.equal(isoDay(new Date(Date.UTC(2026, 0, 5, 23, 59))), "2026-01-05");
});

test("the series keeps zero days instead of a gap", () => {
  const now = new Date(Date.UTC(2026, 10, 12, 15, 0, 0));
  const rows = [
    { _id: "2026-11-12", count: 3 },
    { _id: "2026-11-10", count: 1 },
    { _id: "2026-09-01", count: 99 }, // outside the window: ignored
  ];
  const series = fillDaySeries(rows, now);
  assert.equal(series.length, 30);
  assert.equal(series.at(-1).count, 3);
  assert.equal(series.at(-3).count, 1);
  assert.equal(series[0].count, 0);
});

test("every quality label is present, zero when absent", () => {
  const counts = qualityCounts([
    { _id: "code_keyed", count: 4 },
    { _id: null, count: 7 }, // self_report rows carry no quality
    { _id: "llm_keyed", count: 2 },
  ]);
  assert.deepEqual(counts, [
    { quality: "code_keyed", count: 4 },
    { quality: "llm_keyed", count: 2 },
    { quality: "llm_graded", count: 0 },
    { quality: "self_reported", count: 7 },
  ]);
});

test("a concept's bucket follows the documented rule", () => {
  const concepts = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }, { id: "d", name: "D" }];
  const rows = [
    { _id: { conceptId: "a", outcome: "correct" }, count: 2 }, // mastered
    { _id: { conceptId: "b", outcome: "correct" }, count: 1 }, // struggling: 1 vs 2 incorrect
    { _id: { conceptId: "b", outcome: "incorrect" }, count: 2 },
    { _id: { conceptId: "c", outcome: "correct" }, count: 1 }, // emerging, under-evidenced
    { _id: { conceptId: "c", outcome: "partial" }, count: 3 },
    // d: unassessed
  ];
  const classified = classifyOutcomes({ concepts, rows });
  assert.deepEqual(
    classified.map((entry) => [entry.conceptId, entry.status]),
    [["a", "mastered"], ["b", "struggling"], ["c", "emerging"], ["d", "unassessed"]]
  );
  assert.equal(classified[0].events, 2);
  assert.deepEqual(classified[2].outcomes, { correct: 1, incorrect: 0, partial: 3, unsure: 0 });
});

test("a concept with no pack is still bucketed from its own rows", () => {
  const classified = classifyOutcomes({
    concepts: undefined,
    rows: [
      { _id: { conceptId: "x", outcome: "incorrect" }, count: 1 },
      { _id: { conceptId: "x", outcome: "incorrect" }, count: 1 },
    ],
  });
  assert.equal(classified.length, 1);
  assert.equal(classified[0].status, "struggling");
  assert.equal(classified[0].name, "x");
});

test("the top topic is the first row or null", () => {
  assert.equal(topTopic([]), null);
  assert.equal(topTopic([{ topic: "Recursion", sessions: 5 }]), "Recursion");
});
