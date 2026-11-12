// GET /topics — what a student can start right now, so the client can offer the prepared topics
// instead of leaving them to guess. Reading pack files and one small collection is cheap; nothing
// here calls the model.

const { listTopics } = require("../engine/session");

function list(deps) {
  return async function listTopicsHandler(req, res) {
    res.json({ topics: await listTopics(deps) });
  };
}

module.exports = { list };
