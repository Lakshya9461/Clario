const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

function authRateLimit({ windowMs = WINDOW_MS, max = MAX_FAILURES, now = Date.now } = {}) {
  const failures = new Map();
  return (req, res, next) => {
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    const current = failures.get(key);
    const nowMs = now();
    if (current && current.resetAt > nowMs && current.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - nowMs) / 1000));
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "rate_limited", message: "Too many failed authentication attempts." });
    }

    res.on("finish", () => {
      if (res.statusCode < 400 || res.statusCode >= 500) return;
      const entry = failures.get(key);
      if (!entry || entry.resetAt <= now()) {
        failures.set(key, { count: 1, resetAt: now() + windowMs });
      } else {
        entry.count += 1;
      }
    });
    return next();
  };
}

module.exports = { authRateLimit, WINDOW_MS, MAX_FAILURES };
