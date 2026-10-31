// Express app. Routes live here; index.js only starts the server.
// Phase 0 has one endpoint: GET /health.

const express = require("express");
const cors = require("cors");
const { toHttpError } = require("./errors");

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

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
