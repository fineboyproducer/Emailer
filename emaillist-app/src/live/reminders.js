"use strict";

const { pool } = require("../db");
const { sendEmail, configStatus } = require("../emailProvider");
const { liveConfig } = require("./config");
const { sessionForDate, MIN } = require("./session");
const { renderLiveEmail } = require("./templates");
const { reconcile } = require("./reconcile");
const { mask, maskIn } = require("./mask");

// When each email may go out. `minutesBefore: null` = as soon as someone registers.
// `lateMin` = how long after its scheduled moment a reminder may still go out, which covers
// gaps between runs (the external trigger can be a few minutes late). Past that window the
// reminder is skipped rather than sent at a silly time.
const STEPS = [
  { kind: "confirm", minutesBefore: null, lateMin: 0 },
  { kind: "24h", minutesBefore: 24 * 60, lateMin: 230 },   // Thu 8:00 PM -> 11:50 PM, still "tomorrow"
  { kind: "1h", minutesBefore: 60, lateMin: 30 },
  { kind: "live", minutesBefore: 0, lateMin: 30 },
];

const REGISTRATION_BUFFER_MIN = 15;       // registered < 15 min before a reminder: they just heard from us, skip it
const MAX_ATTEMPTS = 3;
const STALE_PENDING_MS = 15 * MIN;        // a claim older than this belonged to a run that crashed
const SEND_GAP_MS = 550;                  // ~1.8 emails/sec, under Resend's 2/sec default
const MAX_JOBS_PER_RUN = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e || "");

// Pure: decides which (registration, step) pairs are due right now. No database, no clock reads.
//   regs: { id, contact_id, first_name, email, registered_at, event_date: 'YYYY-MM-DD', unsubscribed_at }
//   logs: { registration_id, kind, status, attempts, updated_at }
function plan(nowMs, regs, logs, cfg) {
  const byKey = new Map();
  for (const l of logs) byKey.set(`${l.registration_id}|${l.kind}`, l);

  const jobs = [];
  for (const reg of regs) {
    if (reg.unsubscribed_at || !reg.contact_id || !validEmail(reg.email)) continue;
    const session = sessionForDate(reg.event_date, cfg);
    const regMs = new Date(reg.registered_at).getTime();

    for (const step of STEPS) {
      if (!cfg.emailKinds.includes(step.kind)) continue;

      let due;
      if (step.minutesBefore === null) {
        // As soon as we know about them, until their live is over. Deliberately not capped by how
        // long ago they registered: if the hand-off was delayed by an outage, a late "you're in"
        // is still right, whereas a reminder for a finished live is not.
        due = nowMs < session.endMs;
      } else {
        const at = session.startMs - step.minutesBefore * MIN;
        due = nowMs >= at && nowMs < at + step.lateMin * MIN && regMs <= at - REGISTRATION_BUFFER_MIN * MIN;
      }
      if (!due) continue;

      const existing = byKey.get(`${reg.id}|${step.kind}`);
      if (existing) {
        if (existing.status === "sent") continue;
        if (existing.attempts >= MAX_ATTEMPTS) continue;
        if (existing.status === "pending" && nowMs - new Date(existing.updated_at).getTime() < STALE_PENDING_MS) continue;
      }
      jobs.push({ reg, step, session, existing });
    }
  }
  return jobs;
}

// Reserves a job so two overlapping runs can never both send it. Returns the log id or null.
async function claim(job) {
  if (!job.existing) {
    const { rows } = await pool.query(
      `INSERT INTO live_reminder_log (registration_id, kind, status, attempts)
       VALUES ($1, $2, 'pending', 1)
       ON CONFLICT (registration_id, kind) DO NOTHING
       RETURNING id`,
      [job.reg.id, job.step.kind]
    );
    return rows[0] ? rows[0].id : null;
  }
  const { rows } = await pool.query(
    `UPDATE live_reminder_log
        SET status = 'pending', attempts = attempts + 1, error = NULL, updated_at = now()
      WHERE id = $1 AND attempts = $2
      RETURNING id`,
    [job.existing.id, job.existing.attempts]
  );
  return rows[0] ? rows[0].id : null;
}

async function finish(logId, result) {
  if (result.ok) {
    await pool.query(
      `UPDATE live_reminder_log
          SET status = 'sent', provider_message_id = $2, error = NULL, sent_at = now(), updated_at = now()
        WHERE id = $1`,
      [logId, result.id || null]
    );
  } else {
    await pool.query(
      `UPDATE live_reminder_log SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
      [logId, String(result.error || "unknown error").slice(0, 300)]
    );
  }
}

function unsubscribeUrl(cfg, token) {
  return `${cfg.appUrl}/api/public/live/unsubscribe?token=${encodeURIComponent(token)}`;
}

// This Friday's Google Meet link, from the private live_meet_links table ('' if none has been added).
async function meetUrlFor(dateKey, cache) {
  if (cache && cache.has(dateKey)) return cache.get(dateKey);
  const { rows } = await pool.query("SELECT url FROM live_meet_links WHERE event_date = $1", [dateKey]);
  const url = rows[0] ? rows[0].url : "";
  if (cache) cache.set(dateKey, url);
  return url;
}

async function sendJob(cfg, job, cache, now = Date.now()) {
  const url = unsubscribeUrl(cfg, job.reg.unsubscribe_token);
  const meetUrl = await meetUrlFor(job.reg.event_date, cache);
  const { subject, html, text } = renderLiveEmail(job.step.kind, job.reg, job.session, cfg, url, { meetUrl, nowMs: now });
  return sendEmail({
    to: job.reg.email,
    subject, html, text,
    headers: { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    fromEmail: process.env.FROM_EMAIL,
    fromName: cfg.fromName,
  });
}

async function loadRegistrations(nowMs) {
  const { rows } = await pool.query(
    `SELECT r.id, r.contact_id, r.first_name, r.email, r.registered_at, r.unsubscribed_at,
            to_char(r.event_date, 'YYYY-MM-DD') AS event_date, c.unsubscribe_token
       FROM live_registrations r
       JOIN contacts c ON c.id = r.contact_id
      WHERE r.unsubscribed_at IS NULL
        AND r.event_date BETWEEN (to_timestamp($1 / 1000.0) AT TIME ZONE 'Africa/Lagos')::date - 2
                             AND (to_timestamp($1 / 1000.0) AT TIME ZONE 'Africa/Lagos')::date + 9
      ORDER BY r.registered_at`,
    [nowMs]
  );
  return rows;
}

async function loadLogs(regIds) {
  if (!regIds.length) return [];
  const { rows } = await pool.query(
    "SELECT id, registration_id, kind, status, attempts, updated_at FROM live_reminder_log WHERE registration_id = ANY($1::bigint[])",
    [regIds]
  );
  return rows;
}

const stripWouldAdd = ({ wouldAdd, ...rest }) => rest;

let running = false;

// One pass: work out what is due, send it, record it.
async function runReminders({ dryRun = false, now = Date.now() } = {}) {
  if (running) return { ok: true, healthy: true, skipped: "a run is already in progress" };
  running = true;
  try {
    const cfg = liveConfig();
    const email = configStatus();
    if (!email.configured) {
      return { ok: false, error: "Email is not configured (RESEND_API_KEY and FROM_EMAIL must be set)." };
    }
    if (!cfg.appUrl) {
      return { ok: false, error: "APP_URL is not set, so unsubscribe links can't be built." };
    }

    // Step 1: make sure we know about every registration the website has saved. A failure here
    // never stops reminders for people we already know about; it is reported and the run is
    // flagged unhealthy so the scheduler (GitHub Actions) shows red.
    let rec;
    try { rec = await reconcile({ dryRun, now }); }
    catch (err) { rec = { enabled: true, ok: false, error: err.message }; console.error("[live] reconcile failed:", err.message); }

    // Step 2: work out what is due and send it.
    const regs = await loadRegistrations(now);
    if (dryRun && rec.wouldAdd) regs.push(...rec.wouldAdd);   // so a rehearsal shows the emails the import would trigger
    const logs = await loadLogs(regs.filter((r) => typeof r.id === "number" || /^\d+$/.test(String(r.id))).map((r) => r.id));
    const jobs = plan(now, regs, logs, cfg).slice(0, MAX_JOBS_PER_RUN);

    // A reminder that is due for a Friday with no Meet link on file would go out without one. Say so loudly
    // (a plain warning, not a failure: the emails are still useful), so the link can be added in time.
    const meetCache = new Map();
    const warnings = [];
    for (const d of [...new Set(jobs.filter((j) => j.step.kind !== "confirm").map((j) => j.reg.event_date))]) {
      if (!(await meetUrlFor(d, meetCache))) warnings.push(`No Google Meet link is set for ${d}: reminders for that Friday are going out without it.`);
    }
    if (warnings.length) console.warn("[live] WARNING:", warnings.join(" "));

    const summary = { ok: true, healthy: true, dryRun, registrations: regs.length, due: jobs.length, sent: 0, failed: 0, skipped: 0, errors: [], warnings, reconcile: stripWouldAdd(rec) };
    if (rec.enabled && !rec.ok) summary.healthy = false;
    if (dryRun) return { ...summary, would_send: jobs.map((j) => `${j.step.kind} -> ${mask(j.reg.email)}`) };

    for (const job of jobs) {
      const logId = await claim(job);
      if (!logId) { summary.skipped++; continue; }

      let result;
      try { result = await sendJob(cfg, job, meetCache, now); }
      catch (err) { result = { ok: false, error: (err && err.message) || String(err) }; }
      await finish(logId, result);

      if (result.ok) summary.sent++;
      else {
        summary.failed++;
        if (summary.errors.length < 10) summary.errors.push(`${job.step.kind} -> ${mask(job.reg.email)}: ${maskIn(result.error)}`);
      }
      await sleep(SEND_GAP_MS);
    }

    if (summary.failed) summary.healthy = false;
    if (summary.sent || summary.failed || (rec.imported || 0) > 0) console.log(`[live] run: sent ${summary.sent}, failed ${summary.failed}, skipped ${summary.skipped}, imported ${rec.imported || 0} from the website`);
    return summary;
  } finally {
    running = false;
  }
}

// Called right after a registration so the confirmation goes out in seconds rather than
// waiting for the next 5-minute run. If it fails the scheduled run retries it.
async function sendConfirmationNow(registrationId) {
  try {
    const cfg = liveConfig();
    if (!cfg.emailKinds.includes("confirm") || !cfg.appUrl || !configStatus().configured) return;
    const { rows } = await pool.query(
      `SELECT r.id, r.contact_id, r.first_name, r.email, r.registered_at, r.unsubscribed_at,
              to_char(r.event_date, 'YYYY-MM-DD') AS event_date, c.unsubscribe_token
         FROM live_registrations r JOIN contacts c ON c.id = r.contact_id
        WHERE r.id = $1`,
      [registrationId]
    );
    if (!rows[0]) return;
    const logs = await loadLogs([registrationId]);
    const job = plan(Date.now(), rows, logs, cfg).find((j) => j.step.kind === "confirm");
    if (!job) return;
    const logId = await claim(job);
    if (!logId) return;
    let result;
    try { result = await sendJob(cfg, job); }
    catch (err) { result = { ok: false, error: (err && err.message) || String(err) }; }
    await finish(logId, result);
    if (!result.ok) console.error("[live] confirmation email failed (the scheduled run will retry):", result.error);
  } catch (err) {
    console.error("[live] sendConfirmationNow failed:", err.message);
  }
}

module.exports = { STEPS, plan, runReminders, sendConfirmationNow };
