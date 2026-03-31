const env = require("../config/env");
const { parseCookies } = require("../../auth");
const { findActiveSessionByToken } = require("../modules/auth/service");

async function requireAuth(req, res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie || "");
    const token = cookies[env.sessionCookieName];
    if (!token) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const session = await findActiveSessionByToken(token);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session." });
    }

    req.auth = session;
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { requireAuth };
