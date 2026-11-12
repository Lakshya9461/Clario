const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const { userInputSchema, publicUser } = require("../models/user");

const loginSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(200),
});
const GENERIC_LOGIN_MESSAGE = "Invalid email or password.";
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.8q9q8q9q8q9q8q9q8q9q8q9q8q9q8q";

class AuthInputError extends Error {
  constructor() {
    super("Invalid authentication details.");
    this.status = 400;
    this.code = "invalid_auth";
    this.expose = true;
  }
}

class DuplicateEmailError extends Error {
  constructor() {
    super("An account with that email already exists.");
    this.status = 409;
    this.code = "email_taken";
    this.expose = true;
  }
}

function cookieOptions(config) {
  return {
    httpOnly: true,
    sameSite: config.jwt.cookieSameSite,
    secure: config.jwt.cookieSecure,
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

function create(deps) {
  const config = deps.config;
  const issueToken = (user) =>
    jwt.sign({ sub: String(user._id), role: user.role, email: user.email }, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    });

  return {
    register: async (req, res) => {
      const parsed = userInputSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new AuthInputError();
      const { name, email, password } = parsed.data;
      const existing = await deps.findUserByEmail(email);
      if (existing) throw new DuplicateEmailError();
      const passwordHash = await bcrypt.hash(password, 12);
      let user;
      try {
        user = await deps.createUser({ name, email, passwordHash, role: "student" });
      } catch (error) {
        if (error?.code === 11000) throw new DuplicateEmailError();
        throw error;
      }
      res.cookie("clario_token", issueToken(user), cookieOptions(config));
      res.status(201).json({ user: publicUser(user) });
    },
    login: async (req, res) => {
      const parsed = loginSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new AuthInputError();
      const { email, password } = parsed.data;
      const user = await deps.findUserByEmail(email, { includePassword: true });
      const valid = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH);
      if (!user || !valid) {
        const error = new Error(GENERIC_LOGIN_MESSAGE);
        error.status = 401;
        error.code = "invalid_credentials";
        error.expose = true;
        throw error;
      }
      res.cookie("clario_token", issueToken(user), cookieOptions(config));
      res.json({ user: publicUser(user) });
    },
    logout: (req, res) => {
      res.clearCookie("clario_token", { httpOnly: true, sameSite: config.jwt.cookieSameSite, secure: config.jwt.cookieSecure, path: "/" });
      res.status(204).send();
    },
    me: async (req, res) => {
      const user = await deps.findUserById(req.user.sub);
      if (!user) {
        const error = new Error("Authentication is required.");
        error.status = 401;
        error.code = "unauthorized";
        error.expose = true;
        throw error;
      }
      res.json({ user: publicUser(user) });
    },
  };
}

module.exports = {
  create,
  AuthInputError,
  DuplicateEmailError,
  GENERIC_LOGIN_MESSAGE,
  cookieOptions,
};
