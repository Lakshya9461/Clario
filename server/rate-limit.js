// A fixed-window per-address request limit for the beta.
//
// The beta has no accounts, so the only handle on a caller is the address it connects from.
// This is not an access control: addresses are shared (a whole campus behind one NAT) and the
// header it reads is only trustworthy because the deployment publishes nothing but the proxy.
// It is here so one script cannot burn the model queue or fill the store during a demo, and so
// the failure is a clear 429 instead of a queue that answers "busy" to everyone else.
//
// Counted per window rather than smoothed: a burst straddling the boundary can pass twice, which
// is acceptable for what this protects. State is swept, because a map keyed by address that is
// never pruned is a memory leak on a public port.

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;
// Past this many tracked addresses, drop the expired ones. Keeping the map bounded matters more
// than keeping every live entry: a flood of addresses then degrades to sweeping, not growth.
const MAX_TRACKED = 10_000;

function rateLimit({ windowMs = WINDOW_MS, max = MAX_REQUESTS, now = Date.now } = {}) {
  const windows = new Map();
  let nextSweepAt = 0;

  function sweep(nowMs) {
    for (const [key, window] of windows) {
      if (window.resetAt <= nowMs) windows.delete(key);
    }
    nextSweepAt = nowMs + windowMs;
  }

  return function limitRequests(req, res, next) {
    // CORS preflight is not a request the student made, and answering it with 429 would read as
    // a network failure in the browser.
    if (req.method === "OPTIONS") return next();

    const nowMs = now();
    if (nowMs >= nextSweepAt || windows.size >= MAX_TRACKED) sweep(nowMs);

    const key = req.ip || req.socket?.remoteAddress || "unknown";
    let window = windows.get(key);
    if (!window) {
      window = { count: 0, resetAt: nowMs + windowMs };
      windows.set(key, window);
    }
    window.count += 1;

    if (window.count > max) {
      const retryAfter = Math.max(1, Math.ceil((window.resetAt - nowMs) / 1000));
      res.set("Retry-After", String(retryAfter));
      res.status(429).json({
        error: "rate_limited",
        message: `Too many requests from this connection. Try again in ${retryAfter} seconds.`,
      });
      return undefined;
    }

    return next();
  };
}

module.exports = { rateLimit, WINDOW_MS, MAX_REQUESTS };
