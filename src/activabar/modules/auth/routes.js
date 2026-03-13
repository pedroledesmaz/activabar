const express = require("express");
const env = require("../../config/env");
const { parseCookies } = require("../../../auth");
const { appendSetCookie } = require("../../lib/http");
const { requireAuth } = require("../../middleware/require-auth");
const {
  buildCookie,
  buildClearedCookie,
  login,
  logout,
} = require("./service");

const router = express.Router();

router.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const session = await login(email, password);
    if (!session) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    appendSetCookie(res, buildCookie(session.token));
    return res.json({ ok: true, operator: session.operator });
  } catch (error) {
    return next(error);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    const cookies = parseCookies(req.headers.cookie || "");
    await logout(cookies[env.sessionCookieName]);
    appendSetCookie(res, buildClearedCookie());
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

router.get("/me", requireAuth, (req, res) => {
  res.json({
    ok: true,
    operator: {
      id: req.auth.operator_id,
      email: req.auth.email,
      role: req.auth.role,
    },
  });
});

module.exports = router;
