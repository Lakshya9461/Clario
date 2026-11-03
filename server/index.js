require("dotenv").config();

const db = require("./db");
const app = require("./app");

const port = Number(process.env.PORT) || 3000;

async function start() {
  try {
    await db.connect();
  } catch (error) {
    // Every session and generation path reads or writes Mongo. Listening without it would only
    // turn each request into a buffering timeout, so refuse to start instead.
    console.error(`cannot reach MongoDB at ${db.redactUrl(db.mongoUrl())}: ${error.message}`);
    process.exit(1);
  }

  app.listen(port, () => {
    console.log(`clario server listening on http://127.0.0.1:${port}`);
  });
}

start();
