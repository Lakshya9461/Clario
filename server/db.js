// The one place that opens the MongoDB connection. Used by the server bootstrap and by the
// preview script, so both use the same policy instead of each inventing one.
//
// Nothing here knows about topics, students or packs: it connects, reports why it could not,
// and redacts the password before a connection string reaches a log.

const mongoose = require("mongoose");

const DEFAULT_MONGO_URL = "mongodb://127.0.0.1:27017/clario";
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

function mongoUrl() {
  return process.env.MONGO_URL || DEFAULT_MONGO_URL;
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
