// Mock auth/session layer. Simulates auth endpoints until the backend exposes them.
//
// Tokens live in localStorage. Every call carries an artificial delay so loading
// states are exercised in the UI. No real credentials are validated here — the
// backend is responsible for that when its auth routes come online.

const TOKEN_KEY = "clario.auth.token";
const USER_KEY = "clario.auth.user";
const SESSION_KEY = "clario.session";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const auth = {
  async login({ email, password }) {
    await delay(600);
    if (!email || !password) {
      const error = new Error("Email and password are required.");
      error.code = "invalid_credentials";
      throw error;
    }
    const user = {
      id: "u1",
      email,
      name: email.split("@")[0],
      role: email === "admin@clario.test" ? "admin" : "student",
    };
    const token = "mock-token-" + Math.random().toString(36).slice(2);
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    return { user, token };
  },

  async register({ name, email, password, confirmPassword }) {
    await delay(800);
    if (!name || !email || !password || !confirmPassword) {
      const error = new Error("All fields are required.");
      error.code = "invalid_registration";
      throw error;
    }
    if (password !== confirmPassword) {
      const error = new Error("Passwords do not match.");
      error.code = "password_mismatch";
      throw error;
    }
    if (password.length < 8) {
      const error = new Error("Password must be at least 8 characters.");
      error.code = "password_too_short";
      throw error;
    }
    const user = {
      id: "u2",
      email,
      name,
      role: "student",
    };
    const token = "mock-token-" + Math.random().toString(36).slice(2);
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    return { user, token };
  },

  async logout() {
    await delay(300);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(SESSION_KEY);
    return { ok: true };
  },

  me() {
    const token = localStorage.getItem(TOKEN_KEY);
    const userRaw = localStorage.getItem(USER_KEY);
    if (!token || !userRaw) return null;
    try {
      return JSON.parse(userRaw);
    } catch {
      return null;
    }
  },

  async sessions() {
    await delay(500);
    return [
      {
        id: "s1",
        topic: "JavaScript fundamentals",
        packStatus: "curated",
        createdAt: new Date().toISOString(),
      },
      {
        id: "s2",
        topic: "React basics",
        packStatus: "generated",
        createdAt: new Date().toISOString(),
      },
    ];
  },

  async startSession({ topic, goal }) {
    const { api } = await import("./api.js");
    const started = await api.startSession({ topic, goal });
    const session = {
      sessionId: started.sessionId,
      topic: started.topic,
      packStatus: started.packStatus,
      firstQuestion: started.firstQuestion,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
  },

  getSession() {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  clearSession() {
    localStorage.removeItem(SESSION_KEY);
  },

  async analyticsOverview() {
    try {
      const { api } = await import("./api.js");
      return await api.analyticsOverview();
    } catch {
      // Fallback to mock data until the backend exposes the endpoint.
      await delay(500);
      return {
        sessionsTrend: [
          { date: "2026-11-06", sessions: 3 },
          { date: "2026-11-07", sessions: 5 },
          { date: "2026-11-08", sessions: 2 },
          { date: "2026-11-09", sessions: 7 },
          { date: "2026-11-10", sessions: 4 },
          { date: "2026-11-11", sessions: 6 },
          { date: "2026-11-12", sessions: 8 },
        ],
        evidenceQuality: [
          { quality: "demonstrated", count: 14 },
          { quality: "likely demonstrated", count: 9 },
          { quality: "developing", count: 11 },
          { quality: "self_reported", count: 5 },
          { quality: "unknown", count: 7 },
        ],
        topicsPopularity: [
          { topic: "JavaScript fundamentals", sessions: 12 },
          { topic: "React basics", sessions: 9 },
          { topic: "Python for data", sessions: 6 },
          { topic: "HTML & CSS", sessions: 4 },
          { topic: "TypeScript", sessions: 3 },
        ],
        conceptOutcomes: [
          { concept: "Variables", demonstrated: 8, developing: 4, unknown: 2 },
          { concept: "Functions", demonstrated: 6, developing: 5, unknown: 3 },
          { concept: "Components", demonstrated: 5, developing: 6, unknown: 3 },
          { concept: "Hooks", demonstrated: 3, developing: 7, unknown: 4 },
          { concept: "Async", demonstrated: 2, developing: 6, unknown: 6 },
        ],
      };
    }
  },
};
