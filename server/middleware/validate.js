// The body/params check for a route, in one place.
//
// zod is already the project's schema library (LLM replies, packs), so a request body is validated
// with the same tool rather than by hand. The middleware is deliberately thin:
//
//   validate(schema)                        check and coerce req.body
//   validate(schema, { source: "params" })  same, for req.params or req.query
//   validate(schema, { makeError })         refuse with the route's own contract code
//
// Two decisions worth keeping:
//  - The parsed value is written back to `req.body` only. Express 5's `req.query` is a getter, so
//    assigning to it would be a silent no-op; every non-body source is exposed as
//    `req.validated[source]` instead, and `req.params` is left untouched for the routers.
//  - The refusal is an error the route chose. `invalid_topic` and `invalid_answer` are contract
//    codes; a generic "invalid body" would rename them at the boundary.
//
// Unknown keys are stripped (zod's default): a client cannot smuggle a field a handler does not
// read, such as a role or an owner.

const { z } = require("zod");

class InvalidRequestError extends Error {
  constructor(issues) {
    const detail = issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    super(`Check the request and try again — ${detail}`);
    this.name = "InvalidRequestError";
    this.status = 400;
    this.code = "invalid_request";
    this.expose = true;
  }
}

function validate(schema, { source = "body", makeError = (issues) => new InvalidRequestError(issues) } = {}) {
  // A wrong schema is a programming error, not a request error: fail at wiring time.
  if (!(schema instanceof z.ZodType)) {
    throw new TypeError("validate() needs a zod schema");
  }

  return function validateRequest(req, res, next) {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(makeError(result.error.issues, req));
      return;
    }

    req.validated = { ...(req.validated || {}), [source]: result.data };
    if (source === "body") req.body = result.data;
    next();
  };
}

module.exports = { validate, InvalidRequestError };
