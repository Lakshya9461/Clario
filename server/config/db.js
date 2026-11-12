// The one place that opens the MongoDB connection. Used by the server bootstrap and by the
// preview/benchmark scripts, so both use the same policy instead of each inventing one.
//
// Nothing here knows about topics, students or packs: it connects, reports why it could not, and
// redacts the password before a connection string reaches a log. The URL itself comes from
// config/env.js, so `MONGO_URL` is read in one place.

const mongoose = require("mongoose");
const { readEnv, DEFAULT_MONGO_URL } = require("./env");

// Fail at startup rather than letting every request sit in mongoose's 10s buffer and come back
// as a vague timeout.
const SERVER_SELECTION_TIMEOUT_MS = 15_000;

// A connection string carries the password, and these strings reach logs. `mongodb://user:pw@host`
// and `mongodb+srv://user:pw@host` both become `...://user:<redacted>@host`. An unencoded `:` or
// `@` inside the password is allowed, so the credentials run from the first `:` to the LAST `@`
// before the path; `/` cannot appear raw in a URI password.
function redactUrl(url) {
  return String(url ?? "").replace(/(\/\/[^:/@]+):[^/]*@/, "$1:<redacted>@");
}

// Parsed per call, not cached at import: a script or a test that sets MONGO_URL after requiring
// this module must still get the value it set.
function mongoUrl(env = process.env) {
  return readEnv(env).mongoUrl;
}

async function connect(url = mongoUrl()) {
  await mongoose.connect(url, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS });
  return mongoose.connection;
}

async function disconnect() {
  await mongoose.disconnect();
}

module.exports = {
  connect,
  disconnect,
  mongoUrl,
  redactUrl,
  DEFAULT_MONGO_URL,
  SERVER_SELECTION_TIMEOUT_MS,
};
