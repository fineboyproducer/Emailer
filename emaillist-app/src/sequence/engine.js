"use strict";

const crypto = require("crypto");
const { pool } = require("../db");
const { sendEmail, configStatus } = require("../emailProvider");
const { WAT_OFFSET_MIN } = require("../live/config");
const { sequenceConfig } = require("./config");
const { loadSteps } = require("./content");
const { render } = require("./render");
const { mask, maskIn } = require("../live/mask");

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const MAX_ATTEMPTS = 3;
const STALE_PENDING_MS = 15 * MIN;
const SEND_GAP_MS = 550;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Midnight (WAT) at the start of a YYYY-MM-DD date, as a UTC timestamp.
function watMidnightMs(dateKey) {
  const [y, m, d] = String(dateKey).split("-").map(Number);
  return Date.UTC(y, m - 1, d) - WAT_OFFSET_MIN * MIN;
}

// Start of the current WAT calendar day.
function watDayStartMs(nowMs) {
  const shifted = nowMs + WAT_OFFSET_MIN * MIN;
  return Math.floor(shifted / DAY) * DAY - WAT_OFFSET_MIN * MIN;
}

// Pure: works out which emails are due right now. No database, no clock reads.
//   leads:     [{ email, name, token, anchor: 'YYYY-MM-DD' }]  active contacts who registered for a live; anchor = their first live's Friday
//   purchases: [{ email, product, atMs }]
//   buyers:    Map(email -> { name, token })                    active contacts, used for the buyer track
//   logs:      [{ email, step, status, attempts, updated_at }]
function plan(nowMs, { leads, purchases, buyers, logs }, cfg, steps = loadSteps()) {
  const logBy = new Map(logs.map((l) => [`${l.email}|${l.step}`, l]));
  const bought = new Set(purchases.map((p) => p.email));
  const daySteps = steps.filter((s) => s.unit === "day" && (s.track === "lead" || s.track === "long"));
  const firstId = daySteps.slice().sort((a, b) => a.n - b.n)[0].id;
  const wanted = (email) => !cfg.onlyEmail || email === cfg.onlyEmail;

  const retryable = (email, step) => {
    const l = logBy.get(`${email}|${step}`);
    if (!l) return true;
    if (l.status === "sent") return false;
    if (l.attempts >= MAX_ATTEMPTS) return false;
    if (l.status === "pending" && nowMs - new Date(l.updated_at).getTime() < STALE_PENDING_MS) return false;
    return true;
  };

  const jobs = [];
  for (const lead of leads) {
    if (!wanted(lead.email)) continue;
    // Someone only joins the sequence if its first email actually went out. A person whose first email's
    // window passed (for example because the sequence was switched on later) never gets a mid-story email.
    const started = logBy.get(`${lead.email}|${firstId}`)?.status === "sent";
    for (const step of daySteps) {
      const at = watMidnightMs(lead.anchor) + step.n * DAY + cfg.sendHourWat * HOUR;
      if (nowMs < at || nowMs >= at + cfg.leadLateHours * HOUR) continue;
      if (step.id !== firstId && !started) continue;
      if (step.track === "lead" && bought.has(lead.email)) continue;      // buyers leave the sales emails
      if (!retryable(lead.email, step.id)) continue;
      jobs.push({ email: lead.email, name: lead.name, token: lead.token, step, dueMs: at });
    }
  }
  for (const p of purchases) {
    if (!wanted(p.email)) continue;
    const who = buyers.get(p.email);
    if (!who) continue;                                                    // unsubscribed or not on the list
    for (const step of steps.filter((s) => s.track === `buyer-${p.product}`)) {
      const at = p.atMs + step.n * HOUR;
      if (nowMs < at || nowMs >= at + cfg.buyerLateHours * HOUR) continue;
      if (!retryable(p.email, step.id)) continue;
      jobs.push({ email: p.email, name: who.name, token: who.token, step, dueMs: at });
    }
  }
  return jobs.sort((a, b) => a.dueMs - b.dueMs);
}

function unsubscribeUrl(cfg, token) {
  return `${cfg.appUrl}/api/public/live/stop-emails?token=${encodeURIComponent(token)}`;
}

async function loadLeads() {
  const { rows } = await pool.query(
    `SELECT lower(c.email) AS email, c.name, c.unsubscribe_token AS token,
            to_char(min(r.event_date), 'YYYY-MM-DD') AS anchor
       FROM live_registrations r
       JOIN contacts c ON lower(c.email) = lower(r.email)
      WHERE c.status = 'active'
      GROUP BY c.id, c.email, c.name, c.unsubscribe_token
     HAVING bool_and(r.unsubscribed_at IS NULL)`
  );
  return rows;
}

async function loadPurchases() {
  const { rows } = await pool.query("SELECT lower(email) AS email, product, (extract(epoch from purchased_at) * 1000)::bigint AS at FROM sequence_purchases");
  return rows.map((r) => ({ email: r.email, product: r.product, atMs: Number(r.at) }));
}

async function loadBuyers(emails) {
  if (!emails.length) return new Map();
  const { rows } = await pool.query(
    "SELECT lower(email) AS email, name, unsubscribe_token AS token FROM contacts WHERE status = 'active' AND lower(email) = ANY($1::text[])",
    [emails]
  );
  return new Map(rows.map((r) => [r.email, { name: r.name, token: r.token }]));
}

async function loadLogs() {
  const { rows } = await pool.query("SELECT id, email, step, status, attempts, updated_at FROM sequence_log");
  return rows;
}

// How many emails have gone out today (WAT), live reminders included, because Resend's cap counts all of them.
async function sentToday(nowMs) {
  const since = new Date(watDayStartMs(nowMs));
  const a = await pool.query("SELECT count(*)::int AS n FROM sequence_log WHERE status = 'sent' AND sent_at >= $1", [since]);
  const b = await pool.query("SELECT count(*)::int AS n FROM live_reminder_log WHERE status = 'sent' AND sent_at >= $1", [since]);
  return a.rows[0].n + b.rows[0].n;
}

async function claim(job, existing) {
  if (!existing) {
    const { rows } = await pool.query(
      `INSERT INTO sequence_log (email, step, status, attempts) VALUES ($1, $2, 'pending', 1)
       ON CONFLICT (email, step) DO NOTHING RETURNING id`,
      [job.email, job.step.id]
    );
    return rows[0] ? rows[0].id : null;
  }
  const { rows } = await pool.query(
    `UPDATE sequence_log SET status = 'pending', attempts = attempts + 1, error = NULL, updated_at = now()
      WHERE id = $1 AND attempts = $2 RETURNING id`,
    [existing.id, existing.attempts]
  );
  return rows[0] ? rows[0].id : null;
}

async function finish(logId, result) {
  if (result.ok) {
    await pool.query(
      "UPDATE sequence_log SET status = 'sent', provider_message_id = $2, error = NULL, sent_at = now(), updated_at = now() WHERE id = $1",
      [logId, result.id || null]
    );
  } else {
    await pool.query(
      "UPDATE sequence_log SET status = 'failed', error = $2, updated_at = now() WHERE id = $1",
      [logId, String(result.error || "unknown error").slice(0, 300)]
    );
  }
}

function sendStep(cfg, step, who, token, opts = {}) {
  const url = unsubscribeUrl(cfg, token);
  const { subject, html, text } = render(step, { name: who }, url, opts);
  return sendEmail({
    to: opts.to,
    subject, html, text,
    headers: { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    fromEmail: process.env.FROM_EMAIL,
    fromName: cfg.fromName,
    replyTo: cfg.replyTo || undefined,
  });
}

let running = false;

// One pass: work out what is due, send it (within the daily cap), record it.
async function runSequence({ dryRun = false, now = Date.now() } = {}) {
  const cfg = sequenceConfig();
  if (!cfg.enabled && !dryRun) return { ok: true, enabled: false, note: "SEQ_ENABLED is not true, so nothing is sent." };
  if (running) return { ok: true, enabled: cfg.enabled, skipped: "a run is already in progress" };
  running = true;
  try {
    if (!configStatus().configured) return { ok: false, enabled: cfg.enabled, error: "Email is not configured." };
    if (!cfg.appUrl) return { ok: false, enabled: cfg.enabled, error: "APP_URL is not set, so unsubscribe links can't be built." };

    const [leads, purchases, logs] = await Promise.all([loadLeads(), loadPurchases(), loadLogs()]);
    const buyers = await loadBuyers([...new Set(purchases.map((p) => p.email))]);
    const logByKey = new Map(logs.map((l) => [`${l.email}|${l.step}`, l]));

    const due = plan(now, { leads, purchases, buyers, logs }, cfg);
    const used = await sentToday(now);
    const room = Math.max(0, cfg.dailyCap - used);
    const jobs = due.slice(0, Math.min(room, cfg.maxPerRun));

    const summary = {
      ok: true, enabled: cfg.enabled, dryRun, due: due.length, sent: 0, failed: 0, skipped: 0, errors: [],
      dailyCap: cfg.dailyCap, sentToday: used, heldByCap: Math.max(0, due.length - jobs.length),
    };
    if (summary.heldByCap > 0) summary.warning = `Daily cap reached (${used} of ${cfg.dailyCap} sent today): ${summary.heldByCap} email(s) wait for the next run.`;
    if (dryRun) return { ...summary, would_send: jobs.map((j) => `${j.step.id} -> ${mask(j.email)}`) };

    for (const job of jobs) {
      const existing = logByKey.get(`${job.email}|${job.step.id}`);
      const logId = await claim(job, existing);
      if (!logId) { summary.skipped++; continue; }
      let result;
      try { result = await sendStep(cfg, job.step, job.name, job.token, { to: job.email }); }
      catch (err) { result = { ok: false, error: (err && err.message) || String(err) }; }
      await finish(logId, result);
      if (result.ok) summary.sent++;
      else {
        summary.failed++;
        if (summary.errors.length < 10) summary.errors.push(`${job.step.id} -> ${mask(job.email)}: ${maskIn(result.error)}`);
      }
      await sleep(SEND_GAP_MS);
    }
    if (summary.sent || summary.failed) console.log(`[sequence] run: sent ${summary.sent}, failed ${summary.failed}, held by cap ${summary.heldByCap}`);
    return summary;
  } finally {
    running = false;
  }
}

// Sends one email to the test address so each can be checked on a phone before the sequence goes live.
// Only ever sends to SEQ_TEST_EMAIL, so this endpoint cannot be used to mail anyone else.
async function sendTest(stepId, name) {
  const cfg = sequenceConfig();
  if (!cfg.testEmail) return { ok: false, error: "SEQ_TEST_EMAIL is not set." };
  const step = loadSteps().find((s) => s.id.toLowerCase() === String(stepId || "").toLowerCase());
  if (!step) return { ok: false, error: "Unknown step. Use one of: " + loadSteps().map((s) => s.id).join(", ") };
  if (!configStatus().configured) return { ok: false, error: "Email is not configured." };
  if (!cfg.appUrl) return { ok: false, error: "APP_URL is not set." };
  const result = await sendStep(cfg, step, name || "there", "preview-link-not-real-" + crypto.randomBytes(4).toString("hex"), { to: cfg.testEmail, subjectPrefix: "[TEST] " });
  return result.ok ? { ok: true, sent: step.id, to: mask(cfg.testEmail) } : { ok: false, error: maskIn(result.error) };
}

async function sequenceStatus(now = Date.now()) {
  const cfg = sequenceConfig();
  const steps = loadSteps();
  const byStep = {};
  for (const r of (await pool.query("SELECT step, status, count(*)::int AS n FROM sequence_log GROUP BY 1, 2")).rows) (byStep[r.step] ||= {})[r.status] = r.n;
  const buyers = {};
  for (const r of (await pool.query("SELECT product, count(*)::int AS n FROM sequence_purchases GROUP BY 1")).rows) buyers[r.product] = r.n;
  const leads = (await loadLeads()).length;
  const failures = (await pool.query("SELECT email, step, attempts, error FROM sequence_log WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 20")).rows
    .map((f) => ({ ...f, email: mask(f.email), error: f.error ? maskIn(f.error) : f.error, gave_up: f.attempts >= MAX_ATTEMPTS }));
  const warnings = [];
  if (!cfg.replyTo) warnings.push("SEQ_REPLY_TO is not set: replies to these emails go to the sending address. Set it to an inbox you read.");
  if (!cfg.paystackSecret) warnings.push("PAYSTACK_SECRET_KEY is not set: purchases are not recorded automatically, so buyers keep getting sales emails until you record them by hand.");
  if (cfg.onlyEmail) warnings.push("SEQ_ONLY_EMAIL is set: only that one address is receiving the sequence (rehearsal mode).");
  return {
    ok: true,
    enabled: cfg.enabled, emails: steps.length, leadsInSequence: leads, buyers,
    sentToday: await sentToday(now), dailyCap: cfg.dailyCap,
    replyToSet: !!cfg.replyTo, paystackWebhookConfigured: !!cfg.paystackSecret, rehearsalMode: !!cfg.onlyEmail, testEmailSet: !!cfg.testEmail,
    byStep, failures, warnings,
  };
}

module.exports = { plan, runSequence, sendTest, sequenceStatus, watMidnightMs, watDayStartMs };
