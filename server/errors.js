// One place that turns a thrown error into the contract's { error, message } response.
// Only errors that mark themselves `expose: true` may speak to the client: LLM and database
// failures are internal, and their messages can contain request details (rule 9).

const INTERNAL_MESSAGE = "Something went wrong.";

function toHttpError(error) {
  const status = error.status || error.statusCode || 500;

  if (error.expose && error.code) {
    return { status, body: { error: error.code, message: error.message } };
  }
  if (status >= 500) {
    return { status, body: { error: "server_error", message: INTERNAL_MESSAGE } };
  }
  return { status, body: { error: error.code || "bad_request", message: error.message } };
}

module.exports = { toHttpError };
