// GET /admin/analytics/overview — the numbers behind the admin dashboard.
//
// Every figure here is derived from what is already stored, per request: nothing is cached and
// nothing is written. What the aggregation does is count and compare; estimates and mastery keep
// their own owner (engine/models) and are never recomputed here differently.
//
// Two honest limits worth stating in the response, not only in the docs:
//   - Degraded LLM replies are not recorded anywhere, so there is no rate to report. The shape
//     says `recorded: false, rate: null` instead of printing a confident 0.
//   - `outcomesByConcept` is a concept-level tally over every event in the topic, not a student
//     model: it says which concepts the cohort struggles with, not who.

const { z } = require("zod");
const { queryText } = require("./list-query");
const { TopicNotAvailableError, resolvePack } = require("../engine/session");
const {
  fillDaySeries,
  qualityCounts,
  classifyOutcomes,
  topTopic,
} = require("../engine/analytics");

const overviewQuerySchema = z.object({ topic: queryText() });

function overview(deps) {
  return async function adminOverview(req, res) {
    const { topic: givenTopic } = req.validated.query;

    // Independent counts, fetched together; only the outcomes need to wait for the topic choice.
    const [dayRows, qualityRows, topicRows] = await Promise.all([
      deps.analyticsSessionsPerDay(),
      deps.analyticsEvidenceByQuality(),
      deps.analyticsTopicsBySessions(),
    ]);

    const derived = topTopic(topicRows);
    const topic = givenTopic ?? derived;

    let outcomesByConcept = {
      topic,
      topicSource: givenTopic ? "given" : topic ? "most_sessions" : null,
      packAvailable: true,
      concepts: [],
    };

    if (topic) {
      // An explicit topic with no pack is a 404 like everywhere else. The derived default is not:
      // a dashboard must not die because the most-studied pack was deleted.
      let pack = null;
      try {
        pack = await resolvePack(topic, deps);
      } catch (error) {
        if (!(error instanceof TopicNotAvailableError)) throw error;
        if (givenTopic) throw error;
      }

      const rows = await deps.analyticsOutcomeCounts(topic);
      outcomesByConcept = {
        ...outcomesByConcept,
        packAvailable: Boolean(pack),
        concepts: classifyOutcomes({ concepts: pack?.concepts, rows }),
      };
    }

    res.json({
      sessionsPerDay: fillDaySeries(dayRows),
      evidenceByQuality: qualityCounts(qualityRows),
      outcomesByConcept,
      topicsBySessions: topicRows,
      // Nothing records a degraded reply, so there is no denominator or rate to report. Never 0.
      degradedRate: await deps.analyticsDegradedRate(),
    });
  };
}

module.exports = { overviewQuerySchema, overview };
