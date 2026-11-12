// The admin pack shelf: read, import, edit, approve, delete.
//
// The engine rule this file exists to enforce: only an approval makes a pack curated, and an approval
// means a person read it and checked every answer key. Import and edit therefore force `status` back
// to "generated" — the body cannot approve itself — and approve re-validates before it blesses.
// Nothing here generates a pack, and nothing here serves one to a student: a curated pack in the
// store is found by resolvePack() exactly like a curated file.
//
// Only packs in the store are addressable. A bundled pack is a file in the repository, versioned
// with the code, so it is read-only from the API by design.

const { validatePack } = require("../packs/loader");
const { topicKey } = require("../packs/topic");
const { listSchema, paginate, queryEnum, queryText, skipFor } = require("./list-query");

const PACK_STATUSES = ["curated", "generated"];

const listQuerySchema = listSchema({ q: queryText(), status: queryEnum(PACK_STATUSES) });

class PackNotFoundError extends Error {
  constructor() {
    super("That pack does not exist.");
    this.name = "PackNotFoundError";
    this.status = 404;
    this.code = "pack_not_found";
    this.expose = true;
  }
}

class PackExistsError extends Error {
  constructor(message = "A pack for this topic already exists. Edit that one instead.") {
    super(message);
    this.name = "PackExistsError";
    this.status = 409;
    this.code = "pack_exists";
    this.expose = true;
  }
}

class PackInvalidError extends Error {
  constructor(errors) {
    // The first few reasons, so the message is readable on its own; the whole list rides along.
    const listed = errors.slice(0, 5).join("; ") + (errors.length > 5 ? "; …" : "");
    super(`This pack did not pass validation — ${listed}`);
    this.name = "PackInvalidError";
    this.status = 422;
    this.code = "pack_invalid";
    this.expose = true;
    // Structured detail the contract's error shape allows: an admin can fix the file from this.
    this.details = { errors };
  }
}

// A pack as it may be stored: a draft, whatever the body said. Validation runs on the forced copy, so
// a body marked "curated" is checked against the generated rules too.
function draftOf(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PackInvalidError(["body: expected one pack JSON object"]);
  }
  const candidate = { ...raw, status: "generated" };
  const { valid, errors } = validatePack(candidate);
  if (!valid) throw new PackInvalidError(errors);
  const key = topicKey(candidate.topic);
  if (!key) throw new PackInvalidError(["topic: must not be empty"]);
  return { candidate, key };
}

// A listing is a summary, not the pack: the answer keys stay behind the detail route, which an admin
// opens to review them.
function packSummary(doc) {
  const pack = doc.pack || {};
  return {
    id: String(doc._id),
    packId: pack.packId,
    topic: doc.topic ?? pack.topic,
    topicKey: doc.topicKey,
    status: pack.status,
    version: pack.version,
    conceptCount: Array.isArray(pack.concepts) ? pack.concepts.length : 0,
    questionCount: (pack.diagnostic?.length ?? 0) + (pack.check?.length ?? 0),
    reviewedBy: doc.reviewedBy ?? null,
    reviewedAt: doc.reviewedAt ?? null,
    createdAt: doc.createdAt,
  };
}

async function requirePack(deps, packId) {
  const doc = await deps.findPackById(packId);
  if (!doc) throw new PackNotFoundError();
  return doc;
}

function bundledPacks(deps) {
  return deps.bundledPacks ? deps.bundledPacks() : [];
}

function list(deps) {
  return async function listPacks(req, res) {
    const query = req.validated.query;
    const filter = { q: query.q, status: query.status };
    const total = await deps.countPacks(filter);
    const items = await deps.listPacks({ ...filter, skip: skipFor(query), limit: query.limit });
    res.json(paginate(items.map(packSummary), total, query));
  };
}

function read(deps) {
  return async function readPack(req, res) {
    const doc = await requirePack(deps, req.params.id);
    // The whole pack, keys included: approving a pack is checking its keys, and a reviewer cannot
    // check what is hidden from them. This route is admin-only for exactly that reason.
    res.json({ pack: { ...packSummary(doc), pack: doc.pack } });
  };
}

function create(deps) {
  return async function createPack(req, res) {
    const { candidate, key } = draftOf(req.body);

    if (await deps.findPackByKey(key)) throw new PackExistsError();
    if (bundledPacks(deps).some((pack) => pack.packId === candidate.packId)) {
      throw new PackExistsError(
        "A pack that ships with the app already uses that pack id. Change packId before importing."
      );
    }

    const created = await deps.insertPack({
      topicKey: key,
      topic: candidate.topic,
      pack: candidate,
      reviewedBy: null,
      reviewedAt: null,
    });
    res.status(201).json({ pack: packSummary(created) });
  };
}

function replace(deps) {
  return async function replacePack(req, res) {
    const doc = await requirePack(deps, req.params.id);
    const { candidate, key } = draftOf(req.body);

    // Sessions are running against this id: a pack's identity cannot move under them.
    if (candidate.packId !== doc.pack?.packId) {
      throw new PackInvalidError([
        "packId: a pack's id cannot change; sessions already run against the stored one",
      ]);
    }

    const clash = await deps.findPackByKey(key);
    if (clash && String(clash._id) !== String(doc._id)) throw new PackExistsError();

    const updated = await deps.updatePack(String(doc._id), {
      topicKey: key,
      topic: candidate.topic,
      pack: candidate,
      // The bytes that were reviewed are gone, so the approval is too. Approve again to restore it.
      reviewedBy: null,
      reviewedAt: null,
    });
    if (!updated) throw new PackNotFoundError();
    res.json({ pack: { ...packSummary(updated), pack: updated.pack } });
  };
}

function approve(deps) {
  return async function approvePack(req, res) {
    const doc = await requirePack(deps, req.params.id);

    // The one transition into "curated". Re-validated here rather than trusted from import time: the
    // stored row is what a student will be graded against.
    const candidate = { ...doc.pack, status: "curated" };
    const { valid, errors } = validatePack(candidate);
    if (!valid) throw new PackInvalidError(errors);

    const updated = await deps.updatePack(String(doc._id), {
      pack: candidate,
      reviewedBy: req.user.email,
      reviewedAt: new Date(),
    });
    if (!updated) throw new PackNotFoundError();
    res.json({ pack: { ...packSummary(updated), pack: updated.pack } });
  };
}

function remove(deps) {
  return async function deletePack(req, res) {
    const doc = await requirePack(deps, req.params.id);
    await deps.deletePack(String(doc._id));
    res.status(204).end();
  };
}

module.exports = {
  PACK_STATUSES,
  listQuerySchema,
  PackNotFoundError,
  PackExistsError,
  PackInvalidError,
  packSummary,
  list,
  read,
  create,
  replace,
  approve,
  remove,
};
