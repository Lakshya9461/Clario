// The only place that talks to the server.
//
// Every failure is an ApiError carrying the server's own code and message, so a screen can say
// what actually happened instead of "something went wrong". The API key never reaches this side:
// the base URL is the only thing configured, and Vite bakes it in at build time.

// An empty or relative VITE_API_URL means "same origin": the production proxy serves the built
// client and the API from one host, so the path goes to the same place. Unset keeps the dev
// default, where the client and the server run on different ports.
const BASE = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000";

export class ApiError extends Error {
  constructor(message, { code = "request_failed", status = 0, retryAfter = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    // Seconds the server asked the caller to wait, when it said so (429).
    this.retryAfter = retryAfter;
  }
}

async function request(path, init) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new ApiError("Cannot reach the Clario server. Is it running?", { code: "network" });
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // A proxy error page is not JSON, and the status still says what happened.
  }

  if (!response.ok) {
    // A 429 is the one failure a proxy may answer without this server's JSON, so it gets a
    // readable fallback of its own.
    const fallback =
      response.status === 429
        ? "Too many requests from this connection. Wait a moment, then try again."
        : `The server answered ${response.status}.`;
    throw new ApiError(body?.message || fallback, {
      code: body?.error || (response.status === 429 ? "rate_limited" : "request_failed"),
      status: response.status,
      retryAfter: Number(response.headers.get("Retry-After")) || null,
    });
  }
  return body;
}

function post(path, body) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path) {
  return request(path);
}

export const api = {
  // A topic with no prepared pack answers 404 topic_not_available: this build never generates
  // inside a request.
  startSession: ({ topic, goal }) => post("/session", { topic, goal }),

  diagnose: ({ sessionId, questionId, answer, skip = false }) =>
    post("/diagnose", { sessionId, questionId, answer, skip }),

  plan: (sessionId) => get(`/plan/${encodeURIComponent(sessionId)}`),

  lesson: ({ sessionId, stepIndex }) => post("/lesson", { sessionId, stepIndex }),

  // No questionId: the fetch mode that hands out the next check question.
  nextCheckQuestion: (sessionId) => post("/check", { sessionId }),

  check: ({ sessionId, questionId, answer, why = null }) =>
    post("/check", { sessionId, questionId, answer, why }),

  // What is prepared right now, so a student can pick instead of guessing and getting a 404.
  topics: () => get("/topics"),

  model: (sessionId) => get(`/model/${encodeURIComponent(sessionId)}`),

  // Admin analytics overview: sessions trend, evidence quality, topic popularity,
  // concept outcomes. Admin-only on the server; mocked here until the endpoint is online.
  analyticsOverview: () => get("/admin/analytics/overview"),
};
