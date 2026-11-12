// Express app: the middleware order, and nothing else. Handlers live in controllers/ and are wired
// by routes/; index.js only starts the server.

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const { readEnv } = require("./config/env");
const { notFound, errorHandler } = require("./middleware/error");
const { createRouter } = require("./routes");
const { rateLimit, limitFromEnv } = require("./middleware/rate-limit");
const { requestLogger } = require("./middleware/request-logger");

const config = readEnv();
const app = express();

// The deployment publishes the proxy and nothing else, and the proxy sets X-Forwarded-For, so
// the client address is one hop away. Without this every caller would share the proxy's address
// and one script would use up the whole allowance.
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => callback(null, origin === config.clientOrigin ? config.clientOrigin : false),
  credentials: true,
}));
app.use(requestLogger());

// Health is answered before the limiter: a monitor or a container healthcheck must not be able
// to make the app look down by polling it, and must still work while a caller is being limited.
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// CORS first among the limited routes, so a 429 still carries the headers the browser needs in
// order to read it, then the limiter before the body is parsed, so a rejected request costs
// nothing.
app.use(rateLimit(limitFromEnv()));
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));

app.use(createRouter({ protectAuth: true, config }));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
