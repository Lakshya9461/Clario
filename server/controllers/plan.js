// GET /plan/:sessionId — the plan, recomputed from evidence on every call. Nothing is stored, and
// the model only writes the wording: order and membership are decided in code by engine/plan.js.

const { loadSession } = require("../engine/session");
const { buildPlan } = require("../engine/plan");

function read(deps) {
  return async function readPlan(req, res) {
    const { session, pack } = await loadSession({ sessionId: req.params.sessionId, deps });
    const events = await deps.findEvents(String(session._id));
    const plan = await buildPlan({ session, pack, events, chatJsonFn: deps.chatJson });

    res.json({
      objective: plan.objective,
      findings: plan.findings,
      steps: plan.steps,
      packStatus: pack.status,
      degraded: plan.degraded,
    });
  };
}

module.exports = { read };
