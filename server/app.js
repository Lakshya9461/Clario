// Express app. Routes live here and in routes.js; index.js only starts the server.

const express = require("express");
const cors = require("cors");
const { toHttpError } = require("./errors");
const { createRouter } = require("./routes");

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

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
