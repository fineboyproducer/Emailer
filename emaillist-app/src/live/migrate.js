"use strict";

const fs = require("fs");
const path = require("path");
const { pool } = require("../db");

// Creates the live-registration tables if they don't exist yet. The SQL is idempotent
// (IF NOT EXISTS everywhere), so running it on every start is safe and means there is no
// manual database step when this feature is first deployed.
async function ensureLiveSchema() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "..", "sql", "02_live_reminders.sql"), "utf8");
  await pool.query(sql);
  console.log("[live] database tables ready.");
}

module.exports = { ensureLiveSchema };
