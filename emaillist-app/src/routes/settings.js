const express = require("express");
const rateLimit = require("express-rate-limit");
const { requireLogin } = require("../middleware/auth");
const { configStatus, testConnection } = require("../emailProvider");
const { pool } = require("../db");

const router = express.Router();

const testLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: { error: "Too many connection tests. Wait a few minutes and try again." },
});

// GET /api/settings/resend-status - non-secret snapshot for the diagnostic panel
router.get("/resend-status", requireLogin, (req, res) => {
  res.json(configStatus());
});

// POST /api/settings/resend-test - actually calls Resend to confirm the key works
router.post("/resend-test", requireLogin, testLimiter, async (req, res) => {
  const result = await testConnection();
  if (!result.ok) {
    return res.status(502).json({ error: result.error, code: result.code });
  }
  res.json({ ok: true });
});

// GET /api/settings/db-status - confirms the app can actually reach Supabase
router.get("/db-status", requireLogin, async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, configured: !!(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL) });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
