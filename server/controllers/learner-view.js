// The per-concept view of a learner, in one place so a lesson is pitched from exactly what the
// learner model shows.
//
// The estimate is always recomputed from the append-only evidence by computeEstimate() and never
// read from the store (the LLM never writes an estimate). "unknown" is unassessed, never a
// weakness: it comes with no notes.

const { computeEstimate } = require("../models/models");

function learnerByConcept({ pack, events }) {
  return computeEstimate(events, pack.concepts, pack.status).map((estimate) => ({
    ...estimate,
    name: pack.concepts.find((entry) => entry.id === estimate.conceptId)?.name ?? "",
    // The last three notes are the most recent thing the student showed.
    notes: events
      .filter((event) => String(event.conceptId) === estimate.conceptId && event.note)
      .slice(-3)
      .map((event) => event.note),
  }));
}

module.exports = { learnerByConcept };
