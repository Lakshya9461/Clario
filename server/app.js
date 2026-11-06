// Express app. Routes live here and in routes.js; index.js only starts the server.

const express = require("express");
const cors = require("cors");
const { toHttpError } = require("./errors");
const { createRouter } = require("./routes");
const { rateLimit } = require("./rate-limit");

const app = express();

// The deployment publishes the proxy and nothing else, and the proxy sets X-Forwarded-For, so
// the client address is one hop away. Without this every caller would share the proxy's address
// and one script would use up the whole allowance.
app.set("trust proxy", 1);

// Health is answered before the limiter: a monitor or a container healthcheck must not be able
// to make the app look down by polling it, and must still work while a caller is being limited.
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// CORS first among the limited routes, so a 429 still carries the headers the browser needs in
// order to read it, then the limiter before the body is parsed, so a rejected request costs
// nothing.
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));
app.use(rateLimit());
app.use(express.json({ limit: "1mb" }));

app.use(createRouter());

app.use((req, res) => {
  res.status(404).json({
    error: "not_found",
    message: `No route for ${req.method} ${req.path}`,
  });
});

// Contract: every error is { error, message }. toHttpError decides what may be shown.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const { status, body } = toHttpError(error);
  res.status(status).json(body);
});

module.exports = app;
