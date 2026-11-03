"use strict";

const { pool } = require("../db");
const { liveConfig } = require("./config");
const { nextSession, whenLabel } = require("./session");

const { mask, maskIn } = require("./mask");

// A read-only picture of the upcoming live, for checking the system without SQL.
// Protected by the same secret as the scheduler endpoint; emails are masked.
async function liveStatus(now = Date.now()) {
  const cfg = liveConfig();
  const session = nextSession(now, cfg);
  const d = session.dateKey;

  const regs = (await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS unsubscribed,
            count(*) FILTER (WHERE source = 'page')::int AS via_page,
            count(*) FILTER (WHERE source = 'sync')::int AS via_reconciliation
       FROM live_registrations WHERE event_date = $1`, [d])).rows[0];

  const byKind = {};
  for (const r of (await pool.query(
    `SELECT l.kind, l.status, count(*)::int AS n
       FROM live_reminder_log l JOIN live_registrations r ON r.id = l.registration_id
      WHERE r.event_date = $1 GROUP BY 1, 2`, [d])).rows) {
    (byKind[r.kind] ||= {})[r.status] = r.n;
  }

  const awaitingConfirmation = (await pool.query(
    `SELECT count(*)::int AS n FROM live_registrations r
      WHERE r.event_date = $1 AND r.unsubscribed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM live_reminder_log l WHERE l.registration_id = r.id AND l.kind = 'confirm' AND l.status = 'sent')`, [d])).rows[0].n;

  const failures = (await pool.query(
    `SELECT r.email, l.kind, l.attempts, l.error, l.updated_at
       FROM live_reminder_log l JOIN live_registrations r ON r.id = l.registration_id
      WHERE r.event_date = $1 AND l.status = 'failed' ORDER BY l.updated_at DESC LIMIT 20`, [d])).rows
    .map((f) => ({ ...f, email: mask(f.email), error: f.error ? maskIn(f.error) : f.error, gave_up: f.attempts >= 3 }));

  return {
    ok: true,
    nextLive: { date: d, startsAt: new Date(session.startMs).toISOString(), label: whenLabel(session) },
    registrations: regs,
    reminders: byKind,
    awaitingConfirmation,
    failures,
    reconciliationConfigured: !!(cfg.siteExportUrl && cfg.siteExportSecret),
  };
}

module.exports = { liveStatus };
