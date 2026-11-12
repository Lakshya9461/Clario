// POST /lesson — one lesson for one concept of a plan step.
//
// The plan decides which concept and which step; the lesson is pitched from the same view of the
// concept that /model shows, so the student is always taught from what their evidence says. The
// goal and the notes are data for the prompt, never instructions (data-tags.js).

const { loadSession } = require("../engine/session");
const { planSteps, stepAt } = require("../engine/plan");
const { buildLesson } = require("../engine/lesson");
const { learnerByConcept } = require("./learner-view");

function read(deps) {
  return async function readLesson(req, res) {
    const { sessionId, stepIndex } = req.body ?? {};
    const { session, pack } = await loadSession({
      sessionId,
      userId: req.user?.sub,
      isAdmin: req.user?.role === "admin",
      deps,
    });
    const events = await deps.findEvents(String(session._id));
    const step = stepAt(planSteps(pack, events), stepIndex);
    const concept = pack.concepts.find((entry) => entry.id === step.conceptId);

    const learner = learnerByConcept({ pack, events }).find((entry) => entry.conceptId === concept.id);
    const lesson = await buildLesson({
      pack,
      concept,
      goal: session.goal,
      status: learner ? learner.status : null,
      notes: learner ? learner.notes : [],
      chatJsonFn: deps.chatJson,
    });

    res.json({
      conceptId: concept.id,
      stepIndex,
      markdown: lesson.markdown,
      citations: lesson.citations,
      trace: lesson.trace,
      workedExample: lesson.workedExample,
      degraded: lesson.degraded,
    });
  };
}

module.exports = { read };
