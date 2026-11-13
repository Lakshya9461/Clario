const jwt = require("jsonwebtoken");
const { readEnv } = require("../config/env");

class AuthRequiredError extends Error {
  constructor() {
    super("Authentication is required.");
    this.status = 401;
    this.code = "unauthorized";
    this.expose = true;
  }
}

class ForbiddenError extends Error {
  constructor() {
    super("You do not have permission to perform this action.");
    this.status = 403;
    this.code = "forbidden";
    this.expose = true;
  }
}

function requireAuth(options = {}) {
  const config = options.config || readEnv();
  return (req, res, next) => {
    const token = req.cookies?.clario_token;
    if (!token) return next(new AuthRequiredError());
    try {
      req.user = jwt.verify(token, config.jwt.secret);
      return next();
    } catch {
      return next(new AuthRequiredError());
    }
  };
}

function requireRole(role, options = {}) {
  const findUserById = options.findUserById;
  return async (req, res, next) => {
    if (!req.user) return next(new ForbiddenError());

    // If a database lookup function is provided, re-verify caller still exists and still holds role
    if (typeof findUserById === "function") {
      try {
        const user = await findUserById(req.user.sub);
        if (!user) {
          return next(new AuthRequiredError());
        }
        if (user.role !== role) {
          return next(new ForbiddenError());
        }
        req.account = user;
        return next();
      } catch (err) {
        return next(err);
      }
    }

    if (req.user.role !== role) return next(new ForbiddenError());
    return next();
  };
}

module.exports = { requireAuth, requireRole, AuthRequiredError, ForbiddenError };
