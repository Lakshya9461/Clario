// The two catch-all middlewares, and the one place that turns a thrown error into the contract's
// { error, message } response.
//
// Only errors that mark themselves `expose: true` may speak to the client: LLM and database
// failures are internal, and their messages can contain request details (rule 9). A stack trace
// never reaches a client, and `headersSent` is not this layer's error to swallow: once bytes are
// on the wire Express must close the connection itself.

const INTERNAL_MESSAGE = "Something went wrong.";

function toHttpError(error) {
  const status = error.status || error.statusCode || 500;

  // `details` is the one structured extension the contract allows: a validator that refused a pack
  // can name every reason, which is what makes a 422 actionable for the admin who imported it. It is
  // only ever read from an exposing error, so an internal failure still says nothing but "server_error".
  if (error.expose && error.code) {
    return {
      status,
      body: { error: error.code, message: error.message, ...(error.details ?? {}) },
    };
  }
  if (status >= 500) {
    return { status, body: { error: "server_error", message: INTERNAL_MESSAGE } };
  }
  return { status, body: { error: error.code || "bad_request", message: error.message } };
}

// Nothing matched. Mounted after the router so a wrong path is a JSON 404, not Express's HTML page.
function notFound(req, res) {
  res.status(404).json({
    error: "not_found",
    message: `No route for ${req.method} ${req.path}`,
  });
}

// eslint-disable-next-line no-unused-vars -- Express identifies an error handler by its 4 arguments.
function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const { status, body } = toHttpError(error);
  res.status(status).json(body);
}

module.exports = { toHttpError, notFound, errorHandler };
