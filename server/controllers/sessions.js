// GET/PATCH/DELETE /sessions — the student's own session records.
//
// Every read is filtered on the caller: a session, its evidence and its derived model belong to one
// student, so a sessionId on its own grants nothing. The filter is `req.user.sub`, never a field of
// the request, which is why a query string cannot widen it.
//
// Delete is the student's right to take their data away. It removes the session's evidence with it:
// evidence belongs to a session, and once the session is gone nothing could ever read it again.

const { z } = require("zod");
const { SessionNotFoundError, loadSession } = require("../engine/session");
const { MAX_TITLE_LENGTH } = require("../models/models");
const { listSchema, paginate, queryText, skipFor } = require("./list-query");

const listQuerySchema = listSchema({ topic: queryText(), q: queryText() });

// The only body a session accepts after it exists. A title is a label, never a claim: nothing here
// can change the topic, the pack or the evidence.
const titleSchema = z.object({ title: z.string().trim().min(1).max(MAX_TITLE_LENGTH) });

// What a session looks like in a list or on its own. `userId` is absent on purpose: ownership is the
// filter that found the row, not something the client needs to be told.
function sessionSummary(session) {
  return {
    id: String(session._id),
    // Rows written before titles existed have none, and read as the topic they are about.
    title: session.title || session.topic,
    topic: session.topic,
    packId: session.packId,
    packStatus: session.packStatus,
    goal: String(session.goal ?? ""),
    answeredCount: (session.answeredQuestionIds || []).length,
    createdAt: session.createdAt,
  };
}

// The one authorization path for a session, shared by the three routes that address one by id.
// Without its pack: listing, renaming and deleting must keep working if the pack has been removed.
function ownedSession(req, deps) {
  return loadSession({
    sessionId: req.params.id,
    userId: req.user?.sub,
    isAdmin: req.user?.role === "admin",
    withPack: false,
    deps,
  });
}

function list(deps) {
  return async function listSessions(req, res) {
    const query = req.validated.query;
    // The owner is part of the filter, so two students' rows can never share a page.
    const filter = { userId: req.user.sub, topic: query.topic, q: query.q };
    const total = await deps.countSessions(filter);
    const items = await deps.listSessions({ ...filter, skip: skipFor(query), limit: query.limit });
    res.json(paginate(items.map(sessionSummary), total, query));
  };
}

function read(deps) {
  return async function readSession(req, res) {
    const { session } = await ownedSession(req, deps);
    res.json({ session: sessionSummary(session) });
  };
}

function rename(deps) {
  return async function renameSession(req, res) {
    const { session } = await ownedSession(req, deps);
    const updated = await deps.updateSession(String(session._id), { title: req.body.title });
    if (!updated) throw new SessionNotFoundError(); // deleted between the read and the write
    res.json({ session: sessionSummary(updated) });
  };
}

function remove(deps) {
  return async function deleteSession(req, res) {
    const { session } = await ownedSession(req, deps);
    // Evidence first. If the second step fails, a session without evidence is a retryable state;
    // evidence without a session could never be read again.
    await deps.deleteSessionEvents(String(session._id));
    await deps.deleteSession(String(session._id));
    res.status(204).end();
  };
}

module.exports = {
  listQuerySchema,
  titleSchema,
  sessionSummary,
  list,
  read,
  rename,
  remove,
};
