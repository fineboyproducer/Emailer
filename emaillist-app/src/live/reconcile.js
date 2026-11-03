"use strict";

const { pool } = require("../db");
const { liveConfig } = require("./config");
const { nextSession } = require("./session");
const { cleanRegistration, registerLive } = require("./register");
const { mask, maskIn } = require("./mask");

// Durable hand-off, part 2 of 2.
//
// Part 1 is the browser telling the Emailer about a registration the instant it happens.
// That can fail (Emailer asleep or down, visitor leaves, the page redirects away). Part 2 is
// this: on every scheduler run the Emailer asks the website's Supabase project (through the
// read-only function in supabase-site/) for recent registrations and adds any it does not
// have. The website's table is the durable record; this guarantees the Emailer converges on
// it, retrying automatically every run until it does. Safe to repeat: a registration is keyed
// by (email, event date), so importing the same one again changes nothing.

const FETCH_TIMEOUT_MS = 25000;
const DAY = 24 * 60 * 60 * 1000;

const keyOf = (email, dateKey) => `${email}|${dateKey}`;

async function fetchSiteRegistrations(cfg, nowMs, fetchImpl = fetch) {
  const since = new Date(nowMs - cfg.reconcileWindowDays * DAY).toISOString();
  const url = `${cfg.siteExportUrl}?since=${encodeURIComponent(since)}&event=${encodeURIComponent(cfg.eventName)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { "x-export-secret": cfg.siteExportSecret }, signal: ctrl.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.ok !== true || !Array.isArray(body.registrations)) {
      return { ok: false, error: `website export failed (HTTP ${res.status}${body && body.error ? `: ${body.error}` : ""})` };
    }
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: `website export unreachable: ${err && err.name === "AbortError" ? "timed out" : (err && err.message) || err}` };
  } finally {
    clearTimeout(timer);
  }
}

// Pure. Turns the website's rows into what should be imported.
//  - rows that fail the same validation as the live form are counted and skipped
//  - rows whose live session is already over are skipped (nothing left to remind them about)
//  - the event date is ALWAYS recomputed here from the time they registered, using the same
//    rule as the live registration endpoint; the website's own event_date is only compared,
//    so a visitor with a wrong device clock can never put someone on a past or wrong Friday.
function classifyRows(rows, nowMs, cfg) {
  const importable = [];
  let invalid = 0, stale = 0;
  for (const row of rows) {
    const clean = cleanRegistration(row);
    const registeredAtMs = Date.parse(row && row.registered_at);
    if (!clean.ok || !Number.isFinite(registeredAtMs)) { invalid++; continue; }

    const session = nextSession(registeredAtMs, cfg);
    if (session.endMs <= nowMs) { stale++; continue; }

    const siteDate = row.event_date ? String(row.event_date).slice(0, 10) : null;
    importable.push({
      clean: clean.value,
      registeredAtMs,
      dateKey: session.dateKey,
      siteDateKey: siteDate,
      unsubscribedAt: row.unsubscribed_at ? new Date(row.unsubscribed_at).toISOString() : null,
      key: keyOf(clean.value.email, session.dateKey),
    });
  }
  return { importable, invalid, stale };
}

// dryRun: reads the website but writes nothing; `wouldAdd` lists what a real run would add so
// the caller can show exactly which emails that would trigger.
async function reconcile({ dryRun = false, now = Date.now(), fetchImpl = fetch } = {}) {
  const cfg = liveConfig();
  if (!cfg.siteExportUrl || !cfg.siteExportSecret) {
    return { enabled: false, ok: true, note: "SITE_EXPORT_URL / SITE_EXPORT_SECRET not set; the website is not being reconciled." };
  }

  const got = await fetchSiteRegistrations(cfg, now, fetchImpl);
  if (!got.ok) return { enabled: true, ok: false, error: got.error };

  const { importable, invalid, stale } = classifyRows(got.body.registrations, now, cfg);

  const emails = [...new Set(importable.map((r) => r.clean.email))];
  const existing = new Map(); // key -> unsubscribed_at
  if (emails.length) {
    const { rows } = await pool.query(
      `SELECT lower(email) AS email, to_char(event_date, 'YYYY-MM-DD') AS d, unsubscribed_at
         FROM live_registrations WHERE lower(email) = ANY($1::text[])`,
      [emails]
    );
    for (const r of rows) existing.set(keyOf(r.email, r.d), r.unsubscribed_at);
  }

  const out = {
    enabled: true, ok: true,
    seen: got.body.registrations.length,
    truncated: !!got.body.truncated,
    optOutsIncluded: got.body.opt_outs_included !== false,
    [dryRun ? "wouldImport" : "imported"]: 0,
    alreadyThere: 0, optOutsApplied: 0, invalid, stale, dateMismatch: 0, failed: 0, errors: [],
    wouldAdd: [],
  };

  for (const r of importable) {
    if (r.siteDateKey && r.siteDateKey !== r.dateKey) out.dateMismatch++;

    if (existing.has(r.key)) {
      out.alreadyThere++;
      // The website knows they opted out (e.g. through an old unsubscribe link) and we do not yet.
      if (r.unsubscribedAt && !existing.get(r.key)) {
        out.optOutsApplied++;
        if (!dryRun) {
          await pool.query(
            "UPDATE live_registrations SET unsubscribed_at = $3 WHERE lower(email) = $1 AND event_date = $2 AND unsubscribed_at IS NULL",
            [r.clean.email, r.dateKey, r.unsubscribedAt]
          );
        }
      }
      continue;
    }

    if (dryRun) {
      out.wouldImport++;
      out.wouldAdd.push({
        id: `dry:${r.key}`, contact_id: -1, first_name: r.clean.firstName, email: r.clean.email,
        registered_at: new Date(r.registeredAtMs).toISOString(), event_date: r.dateKey,
        unsubscribed_at: r.unsubscribedAt, unsubscribe_token: "dry-run",
      });
      continue;
    }

    try {
      const result = await registerLive(r.clean, { source: "sync", registeredAtMs: r.registeredAtMs, unsubscribedAt: r.unsubscribedAt });
      if (result.created) out.imported++; else out.alreadyThere++;
    } catch (err) {
      out.failed++;
      if (out.errors.length < 5) out.errors.push(`${mask(r.clean.email)}: ${maskIn(err.message)}`);
    }
  }

  // A truncated export means some registrations were not even looked at: report it as a failure.
  out.ok = out.failed === 0 && !out.truncated;
  if (out.truncated) out.errors.push("Website export was truncated; reduce LIVE_RECONCILE_DAYS or raise the export limit.");
  if (!dryRun) delete out.wouldAdd;
  return out;
}

module.exports = { reconcile, classifyRows, fetchSiteRegistrations };
