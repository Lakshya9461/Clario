// GET /model/:sessionId — the derived learner model. Read-only: nothing is stored, and the client
// only ever sees what the evidence supports.

const { loadSession } = require("../engine/session");
const { learnerByConcept } = require("./learner-view");

function read(deps) {
  return async function readModel(req, res) {
    const { session, pack } = await loadSession({
      sessionId: req.params.sessionId,
      userId: req.user?.sub,
      isAdmin: req.user?.role === "admin",
      deps,
    });
    const events = await deps.findEvents(String(session._id));

    res.json({
      concepts: learnerByConcept({ pack, events }).map((estimate) => ({
        id: estimate.conceptId,
        name: estimate.name,
        status: estimate.status,
        confidence: estimate.confidence,
        eventCount: estimate.eventCount,
        notes: estimate.notes,
      })),
      lowEvidence: Boolean(session.skippedDiagnosis),
    });
  };
}

module.exports = { read };
