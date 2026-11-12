// Writing evidence, in one place.
//
// Evidence is append-only, and an event may only name a concept of the pack it belongs to: the
// grader already restricts itself to the question's concepts, and this is the last check before
// anything is written. The note is a short human-readable reason, so it is capped again here even
// though it is engine-written: the log is the one thing that is never pruned.

function appendEvents({ sessionId, pack, events, deps }) {
  const conceptIds = new Set(pack.concepts.map((concept) => concept.id));
  const documents = events
    .filter((event) => conceptIds.has(event.conceptId))
    .map((event) => ({
      ...event,
      sessionId,
      note: String(event.note ?? "").slice(0, 300),
    }));

  if (!documents.length) return Promise.resolve(0);
  return Promise.resolve(deps.insertEvents(documents)).then(() => documents.length);
}

module.exports = { appendEvents };
