const express = require("express");
const db = require("../../lib/db");

const router = express.Router();

router.get("/", (_req, res) => {
  res.json({ ok: true, service: "activabar" });
});

router.get("/full", async (_req, res, next) => {
  try {
    await db.healthcheck();
    res.json({ ok: true, service: "activabar", database: "ok" });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
