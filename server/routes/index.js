// The route table, and the one composition root.
//
// Every handler lives in controllers/, and this file only says which path reaches which one. The
// dependencies production uses — Mongoose and llm.js — are wired here as `defaultDeps`, so no
// controller imports a database or a model directly. `createRouter(overrides)` merges overrides on
// top, which is how the tests drive the real handlers over real HTTP with a fake store and a fake
// model (see routes.test.js).
//
// No route generates a pack: generation takes minutes and a request may not (A3). An unprepared
// topic is a 404, not a slow request.
//
// The R2 routes (a student's own session records, the admin pack shelf, the account list) always
// mount `requireAuth`, whatever `protectAuth` says for the study routes: they read or write rows that
// belong to one account, so there is no useful anonymous answer to give.

const express = require("express");
const mongoose = require("mongoose");
const { Session, EvidenceEvent, Pack } = require("../models/models");
const { User } = require("../models/user");
const { chatJson } = require("../llm");
const topics = require("../controllers/topics");
const session = require("../controllers/session");
const plan = require("../controllers/plan");
const lesson = require("../controllers/lesson");
const check = require("../controllers/check");
const model = require("../controllers/model");
const sessions = require("../controllers/sessions");
const adminPacks = require("../controllers/admin-packs");
const adminUsers = require("../controllers/admin-users");
const adminAnalytics = require("../controllers/admin-analytics");
const auth = require("../controllers/auth");
const { requireAuth, requireRole } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { authRateLimit } = require("../middleware/auth-rate-limit");
const { containsText, sameText } = require("../controllers/list-query");
const { readEnv } = require("../config/env");

// The filters a listing asks for, as Mongo queries. A controller hands over the values the query
// string was validated into and knows nothing about how they are matched; an absent value adds no
// clause at all, which is what keeps "no filter" from becoming "match nothing".
function sessionFilter({ userId, topic, q }) {
  return {
    // Membership is part of the filter, never a field of the request.
    userId,
    ...(topic ? { topic: sameText(topic) } : {}),
    ...(q ? { title: containsText(q) } : {}),
  };
}

function packFilter({ q, status }) {
  return {
    ...(q ? { topic: containsText(q) } : {}),
    // The review state lives inside the stored pack JSON, not on the row.
    ...(status ? { "pack.status": status } : {}),
  };
}

function userFilter({ q, role }) {
  return {
    ...(role ? { role } : {}),
    ...(q
      ? { $or: [{ name: containsText(q) }, { email: containsText(q) }] }
      : {}),
  };
}

const byNewest = { createdAt: -1 };
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const defaultDeps = {
  chatJson,
  findEvents: (sessionId) => EvidenceEvent.find({ sessionId }).lean(),
  countEvents: (sessionId) => EvidenceEvent.countDocuments({ sessionId }),
  insertEvents: (documents) => EvidenceEvent.insertMany(documents),
  listStored: () => Pack.find({}).lean(),
  config: readEnv(),
  findUserByEmail: (email, options = {}) => {
    const query = User.findOne({ email: email.toLowerCase() });
    return (options.includePassword ? query.select("+passwordHash") : query).lean();
  },
  findUserById: (id) => User.findById(id).lean(),
  createUser: (doc) => User.create(doc),

  listSessions: (query) =>
    Session.find(sessionFilter(query))
      .sort(byNewest)
      .skip(query.skip)
      .limit(query.limit)
      .lean(),
  countSessions: (query) => Session.countDocuments(sessionFilter(query)),
  updateSession: (id, change) => Session.findByIdAndUpdate(id, change, { new: true }).lean(),
  deleteSession: (id) => Session.findByIdAndDelete(id),
  // Evidence belongs to one session; deleting the session takes its evidence with it.
  deleteSessionEvents: (sessionId) => EvidenceEvent.deleteMany({ sessionId }),

  listPacks: (query) =>
    Pack.find(packFilter(query)).sort(byNewest).skip(query.skip).limit(query.limit).lean(),
  countPacks: (query) => Pack.countDocuments(packFilter(query)),
  // An id that cannot be an ObjectId is a 404, not a cast error on the way to the database.
  findPackById: (id) => (mongoose.isValidObjectId(id) ? Pack.findById(id).lean() : null),
  findPackByKey: (topicKey) => Pack.findOne({ topicKey }).lean(),
  insertPack: (doc) => Pack.create(doc),
  updatePack: (id, change) => Pack.findByIdAndUpdate(id, change, { new: true }).lean(),
  deletePack: (id) => Pack.findByIdAndDelete(id),

  listUsers: (query) =>
    User.find(userFilter(query)).sort(byNewest).skip(query.skip).limit(query.limit).lean(),
  countUsers: (query) => User.countDocuments(userFilter(query)),
  updateUserRole: (id, role) =>
    mongoose.isValidObjectId(id) ? User.findByIdAndUpdate(id, { role }, { new: true }).lean() : null,

  // --- admin analytics (R5) -----------------------------------------------
  // Real aggregation pipelines over the two collections that hold the facts. Nothing is stored:
  // every number is derived per request. UTC days, like the client asks for, so a day means the same
  // thing on both ends of the wire.
  analyticsSessionsPerDay: () =>
    Session.aggregate([
      { $match: { createdAt: { $gte: new Date(Date.now() - THIRTY_DAYS_MS) } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  // evidenceQuality is null on self_report rows; the pipeline hands null through and the classifier
  // names it. Grouping by the raw field beats grouping by a made-up placeholder.
  analyticsEvidenceByQuality: () =>
    EvidenceEvent.aggregate([{ $group: { _id: "$evidenceQuality", count: { $sum: 1 } } }]),
  analyticsTopicsBySessions: () =>
    Session.aggregate([
      { $group: { _id: { $toLower: "$topic" }, topic: { $first: "$topic" }, sessions: { $sum: 1 } } },
      { $sort: { sessions: -1, _id: 1 } },
      { $limit: 10 },
      { $project: { _id: 0, topic: 1, sessions: 1 } },
    ]),
  analyticsOutcomeCounts: async (topic) => {
    // Same case-insensitive topic match as the session list.
    const sessions = await Session.find({ topic: sameText(topic) }).select("_id").lean();
    const ids = sessions.map((doc) => doc._id);
    if (!ids.length) return [];
    return EvidenceEvent.aggregate([
      { $match: { sessionId: { $in: ids } } },
      { $group: { _id: { conceptId: "$conceptId", outcome: "$outcome" }, count: { $sum: 1 } } },
    ]);
  },
  // Degraded LLM replies are not recorded anywhere yet, so there is nothing to aggregate. Returning
  // 0 would look like a measurement; returning null says "not instrumented".
  analyticsDegradedRate: () => ({ recorded: false, rate: null }),
};

function createRouter(overrides = {}) {
  const { protectAuth = false, ...dependencyOverrides } = overrides;
  const deps = { ...defaultDeps, ...dependencyOverrides };
  const router = express.Router();
  const authHandlers = auth.create(deps);

  router.post("/auth/register", authRateLimit(), authHandlers.register);
  router.post("/auth/login", authRateLimit(), authHandlers.login);
  router.post("/auth/logout", authHandlers.logout);
  router.get("/auth/me", requireAuth({ config: deps.config }), authHandlers.me);

  const studyRouter = express.Router();

  // What a student can start, curated first, without calling the model.
  studyRouter.get("/topics", topics.list(deps));

  const protectedRouter = express.Router();
  const guard = protectAuth ? requireAuth({ config: deps.config }) : (req, res, next) => next();

  // Start a session on a pack that already exists.
  protectedRouter.post("/session", guard, session.create(deps));

  // Answer or skip one diagnostic question.
  protectedRouter.post("/diagnose", guard, session.diagnose(deps));

  // The plan, recomputed from evidence on every call.
  protectedRouter.get("/plan/:sessionId", guard, plan.read(deps));

  // One lesson for one plan step.
  protectedRouter.post("/lesson", guard, lesson.read(deps));

  // The check: fetch the next question, or answer one.
  protectedRouter.post("/check", guard, check.read(deps));

  // The derived learner model.
  protectedRouter.get("/model/:sessionId", guard, model.read(deps));

  // --- the student's own session records ----------------------------------
  // All four are filtered on the caller, so a sessionId is never enough on its own.
  const signedIn = requireAuth({ config: deps.config });

  router.get(
    "/sessions",
    signedIn,
    validate(sessions.listQuerySchema, { source: "query" }),
    sessions.list(deps)
  );
  router.get("/sessions/:id", signedIn, sessions.read(deps));
  router.patch("/sessions/:id", signedIn, validate(sessions.titleSchema), sessions.rename(deps));
  router.delete("/sessions/:id", signedIn, sessions.remove(deps));

  // --- the admin shelf ----------------------------------------------------
  const adminOnly = [signedIn, requireRole("admin")];

  router.get(
    "/admin/packs",
    adminOnly,
    validate(adminPacks.listQuerySchema, { source: "query" }),
    adminPacks.list(deps)
  );
  router.post("/admin/packs", adminOnly, adminPacks.create(deps));
  router.get("/admin/packs/:id", adminOnly, adminPacks.read(deps));
  router.put("/admin/packs/:id", adminOnly, adminPacks.replace(deps));
  router.post("/admin/packs/:id/approve", adminOnly, adminPacks.approve(deps));
  router.delete("/admin/packs/:id", adminOnly, adminPacks.remove(deps));

  router.get(
    "/admin/users",
    adminOnly,
    validate(adminUsers.listQuerySchema, { source: "query" }),
    adminUsers.list(deps)
  );
  router.patch(
    "/admin/users/:id/role",
    adminOnly,
    validate(adminUsers.roleSchema),
    adminUsers.changeRole(deps)
  );

  router.get(
    "/admin/analytics/overview",
    adminOnly,
    validate(adminAnalytics.overviewQuerySchema, { source: "query" }),
    adminAnalytics.overview(deps)
  );

  router.use(studyRouter);
  router.use(protectedRouter);
  return router;
}

module.exports = { createRouter, defaultDeps };
