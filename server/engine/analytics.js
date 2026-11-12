// Phase R5: admin analytics. Pure parts only — the database pipelines live in routes/index.js next to
// the other aggregations, because the Mongoose shape belongs to the wiring, not the rules.
//
// What a number means lives here instead, so it can be checked without a database: how a day is
// written, what a mastery bucket is, which quality labels exist. An admin badge computed from these
// functions and a dashboard drawn from the pipelines must describe the same students.

const NO_PACK_STATUS = "unknown";

// UTC everywhere. The session schema stores createdAt as a Date; the pipelines group with UTC too, so
// every day has the same meaning no matter where the server runs.
function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

// The 30-day bucket the chart shows, oldest first, files with zero sessions included: a day with no
// rows was still a day the admin spent.
function last30Days(now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = [];
  for (let back = 29; back >= 0; back -= 1) {
    days.push(isoDay(new Date(today - back * 24 * 60 * 60 * 1000)));
  }
  return days;
}

// Rows from "group by day" in any order, normalized to the full 30-day series.
function fillDaySeries(rows, now = new Date()) {
  const counts = new Map();
  for (const row of rows) {
    if (row?._id) counts.set(String(row._id), Number(row.count) || 0);
  }
  return last30Days(now).map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

// Every quality the schema can carry, so the dashboard always shows all of them, zero-filled.
// `self_reported` is the one label with no quality on the row: the student's claim is not graded.
const QUALITY_LABELS = ["code_keyed", "llm_keyed", "llm_graded", "self_reported"];

function qualityCounts(rows) {
  const counts = new Map(QUALITY_LABELS.map((label) => [label, 0]));
  for (const row of rows) {
    const key = row?._id == null ? "self_reported" : String(row._id);
    counts.set(key, (counts.get(key) ?? 0) + Number(row.count) || 0);
  }
  return QUALITY_LABELS.map((quality) => ({ quality, count: counts.get(quality) ?? 0 }));
}

// Rows from "group by concept and outcome" → one entry per concept.
//
// Buckets, from the student's weakest signal up:
//   unassessed  no events at all
//   struggling  at least as many incorrect as correct, and at least one incorrect
//   mastered    at least 2 graded events (correct + incorrect) and at least 60% correct
//   emerging    anything else with events
// Partial/unsure are evidence without a verdict, so they never turn a concept `mastered` on their own.
function classifyOutcomes({ concepts, rows }) {
  const tally = new Map();
  const add = (conceptId, outcome, count) => {
    const entry = tally.get(conceptId) ?? { correct: 0, incorrect: 0, partial: 0, unsure: 0 };
    entry[outcome] = (entry[outcome] ?? 0) + Number(count) || 0;
    tally.set(conceptId, entry);
  };
  for (const row of rows) {
    const conceptId = row?._id?.conceptId ?? row?.conceptId;
    const outcome = row?._id?.outcome ?? row?.outcome;
    if (conceptId && outcome) add(String(conceptId), String(outcome), row.count);
  }

  // With a pack, every concept is listed (so gaps are visible); without one we can only report the
  // concepts that were touched.
  const source = concepts ?? [...tally.keys()].map((id) => ({ id, name: id }));

  return source.map((concept) => {
    const outcomes = tally.get(concept.id) ?? { correct: 0, incorrect: 0, partial: 0, unsure: 0 };
    const correct = outcomes.correct;
    const incorrect = outcomes.incorrect;
    const events = correct + incorrect + outcomes.partial + outcomes.unsure;
    const graded = correct + incorrect;

    let status;
    if (events === 0) status = "unassessed";
    else if (incorrect > 0 && incorrect >= correct) status = "struggling";
    else if (graded >= 2 && correct / graded >= 0.6) status = "mastered";
    else status = "emerging";

    return {
      conceptId: concept.id,
      name: concept.name ?? concept.id,
      status,
      events,
      outcomes,
    };
  });
}

// The topic that gets the outcomes table when the caller does not name one.
function topTopic(topics) {
  if (!Array.isArray(topics) || topics.length === 0) return null;
  return topics[0]?.topic ?? null;
}

module.exports = {
  NO_PACK_STATUS,
  isoDay,
  last30Days,
  fillDaySeries,
  qualityCounts,
  classifyOutcomes,
  topTopic,
  QUALITY_LABELS,
};
