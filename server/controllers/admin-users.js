// GET /admin/users and PATCH /admin/users/:id/role — the account list, and the one field an admin may
// change on another account.
//
// What a listing may contain is the whole point of this file: an account row is name, email, role and
// when it was created. Nothing else leaves through here, not even a hash, and not by remembering to
// delete it — `publicUser` names the five safe fields, so a store that hands back more cannot leak it.
//
// The role is the only editable field, and an admin cannot edit their own: demoting the last admin
// would lock every admin route, and there is no second actor to undo it.

const { z } = require("zod");
const { publicUser } = require("../models/user");
const { listSchema, paginate, queryEnum, queryText, skipFor } = require("./list-query");

const ROLES = ["student", "admin"];

const listQuerySchema = listSchema({ q: queryText(), role: queryEnum(ROLES) });

// Same two values as the schema's enum: a third role is a client bug, refused rather than ignored.
const roleSchema = z.object({ role: z.enum(ROLES) });

class UserNotFoundError extends Error {
  constructor() {
    super("That user does not exist.");
    this.name = "UserNotFoundError";
    this.status = 404;
    this.code = "user_not_found";
    this.expose = true;
  }
}

class CannotChangeOwnRoleError extends Error {
  constructor() {
    super("You cannot change your own role. Ask another admin to do it.");
    this.name = "CannotChangeOwnRoleError";
    this.status = 400;
    this.code = "cannot_change_own_role";
    this.expose = true;
  }
}

function list(deps) {
  return async function listUsers(req, res) {
    const query = req.validated.query;
    // The caller's own row is in here too, like every other: this is the admin surface, and an admin
    // who cannot see themselves cannot tell who else exists.
    const filter = { q: query.q, role: query.role };
    const total = await deps.countUsers(filter);
    const items = await deps.listUsers({ ...filter, skip: skipFor(query), limit: query.limit });
    res.json(paginate(items.map(publicUser), total, query));
  };
}

function changeRole(deps) {
  return async function changeUserRole(req, res) {
    if (String(req.params.id) === String(req.user?.sub)) throw new CannotChangeOwnRoleError();

    const updated = await deps.updateUserRole(req.params.id, req.body.role);
    if (!updated) throw new UserNotFoundError();
    res.json({ user: publicUser(updated) });
  };
}

module.exports = {
  ROLES,
  listQuerySchema,
  roleSchema,
  UserNotFoundError,
  CannotChangeOwnRoleError,
  list,
  changeRole,
};
