require("dotenv").config();

const { assertBootable, ConfigError } = require("./config/env");
const db = require("./config/db");
const app = require("./app");

// Fail fast, before a socket is opened or a database is touched: a missing MONGO_URL or JWT_SECRET
// is a deployment mistake, and starting anyway would either write to the wrong database or sign
// tokens anyone can forge. The message names variables, never values.
let config;
try {
  config = assertBootable();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

async function start() {
  try {
    await db.connect();
  } catch (error) {
    // Every session and generation path reads or writes Mongo. Listening without it would only
    // turn each request into a buffering timeout, so refuse to start instead.
    console.error(`cannot reach MongoDB at ${db.redactUrl(config.mongoUrl)}: ${error.message}`);
    process.exit(1);
  }

  app.listen(config.port, () => {
    console.log(`clario server listening on port ${config.port}`);
  });
}

start();
