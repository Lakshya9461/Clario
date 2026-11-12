// A study session: which pack it runs on, and how far the student has got.
//
// Nothing here names a subject. Concepts, questions and sources come from the pack; this module
// only knows the pack SHAPE, the quiz rules from the contract, and where a pack lives.
// No LLM calls happen here either: choosing the next question is deterministic.
//
// One field records progress: answeredQuestionIds. A question is added when the student answers
// or skips it, in one atomic update, so a double submit cannot be graded twice and a skipped
// question is never asked again (a skip leaves no evidence behind, so it could not otherwise be
// told apart from an unanswered one).

const mongoose = require("mongoose");
const { Session, Pack } = require("../models/models");
const { loadBundledPacks, findPackByTopic } = require("../packs/loader");
const { normalizeTopic } = require("../packs/topic");

// Contract: stop the diagnostic after 3-5 questions, and cover every difficulty tier if the
// pack allows it, so the plan is not built from three questions of the same kind.
const MIN_DIAGNOSTIC = 3;
const MAX_DIAGNOSTIC = 5;
// Contract: the check is three questions at rising difficulty.
const CHECK_TIERS = [1, 2, 3];

class TopicNotAvailableError extends Error {
  constructor(message = "This topic is not available yet. Try one that has already been prepared.") {
    super(message);
    this.name = "TopicNotAvailableError";
    this.status = 404;
    this.code = "topic_not_available";
    this.expose = true;
  }
}

class SessionNotFoundError extends Error {
  constructor() {
    super("That study session does not exist. Start a new one.");
    this.name = "SessionNotFoundError";
    this.status = 404;
    this.code = "session_not_found";
    this.expose = true;
  }
}

class QuestionNotFoundError extends Error {
  constructor() {
    super("That question does not belong to this session.");
    this.name = "QuestionNotFoundError";
    this.status = 400;
    this.code = "question_not_found";
    this.expose = true;
  }
}

class QuestionAlreadyAnsweredError extends Error {
  constructor() {
    super("That question has already been answered.");
    this.name = "QuestionAlreadyAnsweredError";
    this.status = 409;
    this.code = "question_already_answered";
    this.expose = true;
  }
}

class InvalidAnswerError extends Error {
  constructor(message = "Send an answer as text, or skip the question.") {
    super(message);
    this.name = "InvalidAnswerError";
    this.status = 400;
    this.code = "invalid_answer";
    this.expose = true;
  }
}

// A written answer goes into the model prompt whole, so an unbounded one is a cost and an
// injection surface at the same time. The cap is well above any answer a student would write for
// one question, so a real answer is never refused — only a paste of a whole document.
const MAX_ANSWER_LENGTH = 4000;

class AnswerTooLongError extends Error {
  constructor(message = `That answer is longer than ${MAX_ANSWER_LENGTH} characters. Write a shorter one.`) {
    super(message);
    this.name = "AnswerTooLongError";
    this.status = 400;
    this.code = "answer_too_long";
    this.expose = true;
  }
}

// A pasted source cannot be honoured: it would need a pack generated from it, and a request may
// not wait minutes for that. Saying so is better than ignoring the paste and answering from
// general knowledge while the student believes their own text was used.
class SourceTextNotSupportedError extends Error {
  constructor() {
    super(
      "Pasting source text is not supported yet: this build only serves topics that have already " +
        "been prepared. Try a prepared topic."
    );
    this.name = "SourceTextNotSupportedError";
    this.status = 400;
    this.code = "source_text_not_supported";
    this.expose = true;
  }
}

// ---------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------

// A3: a session only ever runs on a pack that already exists — a JSON file committed with the
// repository (curated, or a reviewed generated one), or one an offline generation run stored.
// Generating here would put minutes of latency inside a request, so a topic with no pack is a 404.
async function resolvePack(topic, deps = {}) {
  const normalized = normalizeTopic(topic);
  const topicKey = normalized.toLowerCase();

  const fromFile = findPackByTopic(normalized, bundledPacks(deps));
  if (fromFile) return fromFile;

  const stored = await storedPack(topicKey, deps);
  if (stored?.pack) return stored.pack;

  throw new TopicNotAvailableError();
}

function bundledPacks(deps) {
  return deps.bundledPacks ? deps.bundledPacks() : loadBundledPacks().packs;
}

// What a student can start right now: every pack that ships with the app, plus every generated one
// the store still has. Curated first, and one entry per topic.
//
// `reviewed` is not the same claim as `status`. A generated pack keeps status "generated" (A4: only
// a curated, code-keyed pack can say "demonstrated"), but a generated pack that is committed to the
// repository was read and key-checked by a human before it got there, while one still in the store
// may be exactly as the model wrote it. The distinction is worth reporting, because the client tells
// the student which kind of pack they are practising on.
async function listTopics(deps = {}) {
  const bundled = bundledPacks(deps);
  const stored = deps.listStored ? await deps.listStored() : await Pack.find({}).lean();

  const topics = [];
  const seen = new Set();
  const add = (pack, source, reviewed) => {
    const key = String(pack.topic).trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    topics.push({ topic: pack.topic, source, reviewed });
  };

  for (const pack of bundled.filter((entry) => entry.status === "curated")) add(pack, "curated", true);
  for (const pack of bundled.filter((entry) => entry.status !== "curated")) add(pack, "generated", true);
  // A stored pack is a draft unless an admin approved it. Approval is a person reading every answer
  // key, which is exactly what makes a stored pack curated — so it is reported the same way a pack
  // written by hand is, because as far as the student is concerned it was checked the same way.
  for (const entry of stored) {
    if (!entry?.pack) continue;
    const curated = entry.pack.status === "curated";
    add(entry.pack, curated ? "curated" : "generated", curated);
  }

  return topics;
}

async function storedPack(topicKey, deps) {
  return deps.findStored
    ? deps.findStored(topicKey)
    : await Pack.findOne({ topicKey }).lean();
}

// A session stores which pack it started on. Looking the pack up by the session's own topic would
// silently swap the pack under a running session if one were regenerated, so the packId must
// match before it is used.
async function packForSession(session, deps = {}) {
  const fromFile = bundledPacks(deps).find((pack) => pack.packId === session.packId);
  if (fromFile) return fromFile;

  const stored = await storedPack(String(session.topic).trim().toLowerCase(), deps);
  if (stored?.pack && stored.pack.packId === session.packId) return stored.pack;

  throw new TopicNotAvailableError(
    "The study pack for this session is no longer available. Start a new session."
  );
}

async function createSession({ topic, goal = "", userId, deps = {} } = {}) {
  const pack = await resolvePack(topic, deps);
  const create = deps.createSession || ((doc) => Session.create(doc));
  const session = await create({
    ...(userId ? { userId } : {}),
    // A new session is named after the topic it is about; the student renames it from the list.
    title: pack.topic,
    topic: pack.topic,
    packId: pack.packId,
    packStatus: pack.status,
    goal: String(goal ?? "").slice(0, 40),
  });
  return { session, pack };
}

// A4 hangs off the pack a session STARTED on, not off the pack as it is today. An admin can approve a
// stored pack while sessions are running on it; the keys that graded those answers were the model's,
// and the evidence must keep saying so. Every grading, estimate and plan path reads the pack it is
// handed, so this is the one place that pins the provenance and all of them inherit it.
function provenanceFor(session, pack) {
  const status = session?.packStatus || pack.status;
  return status === pack.status ? pack : { ...pack, status };
}

async function loadSession({ sessionId, userId, isAdmin = false, withPack = true, deps = {} } = {}) {
  if (typeof sessionId !== "string" || !mongoose.isValidObjectId(sessionId)) {
    throw new SessionNotFoundError();
  }
  const find =
    deps.findSession ||
    ((id, owner) =>
      Session.findOne({
        _id: id,
        ...(owner && !isAdmin ? { userId: owner } : {}),
      }).lean());
  let session;
  try {
    session = await find(sessionId, userId);
  } catch {
    throw new SessionNotFoundError(); // a malformed id inside a valid shape
  }
  if (!session) throw new SessionNotFoundError();
  // Renaming or deleting a session does not need its pack, and must still work when the pack is gone:
  // a student can always take their own data away.
  if (!withPack) return { session };
  const pack = await packForSession(session, deps);
  return { session, pack: provenanceFor(session, pack) };
}

// Claims the right to grade one answer. Returns false when the question was already claimed,
// which is what makes a double submit a 409 instead of a second set of evidence events.
async function claimQuestion({ session, questionId, skipped = false, deps = {} } = {}) {
  const update = { $addToSet: { answeredQuestionIds: questionId } };
  if (skipped) update.$set = { skippedDiagnosis: true };
  const claim =
    deps.claim ||
    ((id, change) =>
      Session.findOneAndUpdate({ _id: id, answeredQuestionIds: { $ne: questionId } }, change, {
        new: true,
      }));
  const claimed = await claim(session._id, update);
  return Boolean(claimed);
}

// Gives a claim back. The claim exists so an answer is graded once, not so a failed grading
// consumes the question: when the model is busy or unreachable, no evidence was written and the
// student must be able to retry the same answer. Only called before anything is appended.
async function releaseQuestion({ session, questionId, deps = {} } = {}) {
  const release =
    deps.release ||
    ((id, update) => Session.updateOne({ _id: id }, update));
  await release(session._id, { $pull: { answeredQuestionIds: questionId } });
}

// ---------------------------------------------------------------------------
// Question choice (pure: no database, no clock)
// ---------------------------------------------------------------------------

// What the client is allowed to know. The key and the fallback feedback stay on the server:
// sending either would hand out the answer.
function publicQuestion(question) {
  const visible = {
    id: question.id,
    kind: question.kind,
    prompt: question.prompt,
    conceptIds: question.conceptIds,
    difficulty: question.difficulty,
    transfer: question.transfer,
    requiresWhy: question.requiresWhy,
  };
  if (question.options) visible.options = question.options;
  if (question.code) visible.code = question.code;
  return visible;
}

function answeredSet(answeredQuestionIds = []) {
  return new Set(answeredQuestionIds);
}

// Prefer a difficulty that has not been assessed yet, so a short diagnostic still covers an
// easy, a medium and a hard question.
function nextDiagnosticQuestion(pack, answeredQuestionIds = []) {
  const answered = answeredSet(answeredQuestionIds);
  const remaining = pack.diagnostic.filter((question) => !answered.has(question.id));
  if (!remaining.length) return null;

  const covered = new Set(
    pack.diagnostic
      .filter((question) => answered.has(question.id))
      .map((question) => question.difficulty)
  );
  const uncovered = remaining
    .filter((question) => !covered.has(question.difficulty))
    .sort((a, b) => a.difficulty - b.difficulty);

  return uncovered[0] || remaining[0];
}

function answeredDiagnostic(pack, answeredQuestionIds = []) {
  const answered = answeredSet(answeredQuestionIds);
  return pack.diagnostic.filter((question) => answered.has(question.id));
}

function diagnosisComplete(pack, answeredQuestionIds = []) {
  const answers = answeredDiagnostic(pack, answeredQuestionIds);
  if (answers.length >= MAX_DIAGNOSTIC) return true;
  if (answers.length < MIN_DIAGNOSTIC) return false;
  return new Set(answers.map((question) => question.difficulty)).size === CHECK_TIERS.length;
}

// The check runs one question per tier, in rising order. A tier that already has an answer is
// done, so the next question comes from the lowest tier still uncovered — otherwise a pack with
// several questions per tier would keep serving easy questions and never reach the hard one.
function nextCheckQuestion(pack, answeredQuestionIds = []) {
  const answered = answeredSet(answeredQuestionIds);
  for (const tier of CHECK_TIERS) {
    if (pack.check.some((question) => question.difficulty === tier && answered.has(question.id))) {
      continue;
    }
    const question = pack.check.find((entry) => entry.difficulty === tier);
    if (question) return question;
  }
  return null;
}

function checkComplete(pack, answeredQuestionIds = []) {
  const answered = answeredSet(answeredQuestionIds);
  return CHECK_TIERS.every((tier) =>
    pack.check.some((question) => question.difficulty === tier && answered.has(question.id))
  );
}

// The question the client asked about must be in the list it claims to answer from.
function findQuestion(pack, section, questionId) {
  const list = section === "check" ? pack.check : pack.diagnostic;
  const question = list.find((entry) => entry.id === questionId);
  if (!question) throw new QuestionNotFoundError();
  return question;
}

// A4: generated evidence is weaker, so the client must say "likely demonstrated", never
// "demonstrated".
function certaintyFor(packStatus, estimate) {
  if (estimate.status !== "demonstrated") return null;
  return packStatus === "curated" && estimate.evidenceQuality === "code_keyed"
    ? "demonstrated"
    : "likely demonstrated";
}

module.exports = {
  MIN_DIAGNOSTIC,
  MAX_DIAGNOSTIC,
  CHECK_TIERS,
  TopicNotAvailableError,
  SessionNotFoundError,
  QuestionNotFoundError,
  QuestionAlreadyAnsweredError,
  InvalidAnswerError,
  AnswerTooLongError,
  MAX_ANSWER_LENGTH,
  SourceTextNotSupportedError,
  resolvePack,
  listTopics,
  packForSession,
  provenanceFor,
  createSession,
  loadSession,
  claimQuestion,
  releaseQuestion,
  publicQuestion,
  nextDiagnosticQuestion,
  answeredDiagnostic,
  diagnosisComplete,
  nextCheckQuestion,
  checkComplete,
  findQuestion,
  certaintyFor,
};
