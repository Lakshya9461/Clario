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

const express = require("express");
const { EvidenceEvent, Pack } = require("../models/models");
const { chatJson } = require("../llm");
const topics = require("../controllers/topics");
const session = require("../controllers/session");
const plan = require("../controllers/plan");
const lesson = require("../controllers/lesson");
const check = require("../controllers/check");
const model = require("../controllers/model");

const defaultDeps = {
  chatJson,
  findEvents: (sessionId) => EvidenceEvent.find({ sessionId }).lean(),
  countEvents: (sessionId) => EvidenceEvent.countDocuments({ sessionId }),
  insertEvents: (documents) => EvidenceEvent.insertMany(documents),
  listStored: () => Pack.find({}).lean(),
};

function createRouter(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const router = express.Router();

  // What a student can start, curated first, without calling the model.
  router.get("/topics", topics.list(deps));

  // Start a session on a pack that already exists.
  router.post("/session", session.create(deps));

  // Answer or skip one diagnostic question.
  router.post("/diagnose", session.diagnose(deps));

  // The plan, recomputed from evidence on every call.
  router.get("/plan/:sessionId", plan.read(deps));

  // One lesson for one plan step.
  router.post("/lesson", lesson.read(deps));

  // The check: fetch the next question, or answer one.
  router.post("/check", check.read(deps));

  // The derived learner model.
  router.get("/model/:sessionId", model.read(deps));

  return router;
}

module.exports = { createRouter, defaultDeps };
