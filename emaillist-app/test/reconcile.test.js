"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || "postgresql://u:p@127.0.0.1:1/none";

const { liveConfig } = require("../src/live/config");
const { classifyRows, fetchSiteRegistrations } = require("../src/live/reconcile");
const { mask, maskIn } = require("../src/live/mask");

const cfg = liveConfig({});
const wat = (iso) => new Date(iso + "+01:00").getTime();
const row = (over = {}) => ({
  id: "u1", first_name: "Ada", email: "Ada@Example.com", whatsapp: "+2348012345678", artist_name: null,
  event_name: cfg.eventName, event_date: "2026-10-30", registered_at: "2026-10-27T10:00:00+01:00", unsubscribed_at: null, ...over,
});
const NOW = wat("2026-10-28T12:00:00"); // Wednesday

test("classify: a normal registration is importable, with a server-computed Friday", () => {
  const { importable, invalid, stale } = classifyRows([row()], NOW, cfg);
  assert.equal(importable.length, 1); assert.equal(invalid, 0); assert.equal(stale, 0);
  assert.equal(importable[0].dateKey, "2026-10-30");
  assert.equal(importable[0].clean.email, "ada@example.com");
  assert.equal(importable[0].key, "ada@example.com|2026-10-30");
});

test("classify: the website's own event_date never decides the Friday", () => {
  const { importable } = classifyRows([row({ event_date: "2026-09-25" })], NOW, cfg); // wrong device clock
  assert.equal(importable[0].dateKey, "2026-10-30");
  assert.equal(importable[0].siteDateKey, "2026-09-25"); // kept so the mismatch can be reported
});

test("classify: registrations for a live that is already over are skipped, not scheduled", () => {
  const old = row({ registered_at: "2026-10-20T10:00:00+01:00" }); // was for Fri 23 Oct
  const { importable, stale } = classifyRows([old], NOW, cfg);
  assert.equal(importable.length, 0); assert.equal(stale, 1);
});

test("classify: registered during a live, after it ended, rolls to the next Friday", () => {
  const { importable } = classifyRows([row({ registered_at: "2026-10-30T21:30:00+01:00" })], wat("2026-10-31T09:00:00"), cfg);
  assert.equal(importable[0].dateKey, "2026-11-06");
});

test("classify: invalid rows are counted, never imported", () => {
  const rows = [row({ email: "nope" }), row({ first_name: "" }), row({ registered_at: "garbage" }), row({ whatsapp: "123" })];
  const { importable, invalid } = classifyRows(rows, NOW, cfg);
  assert.equal(importable.length, 0); assert.equal(invalid, 4);
});

test("classify: an opt-out recorded on the website travels with the row", () => {
  const { importable } = classifyRows([row({ unsubscribed_at: "2026-10-28T08:00:00Z" })], NOW, cfg);
  assert.equal(importable[0].unsubscribedAt, "2026-10-28T08:00:00.000Z");
});

test("fetch: sends the secret header, asks for the right window and event, handles failures", async () => {
  const c = liveConfig({ SITE_EXPORT_URL: "https://site.example/functions/v1/export", SITE_EXPORT_SECRET: "s".repeat(30) });
  let seen;
  const ok = await fetchSiteRegistrations(c, NOW, async (url, init) => {
    seen = { url, secret: init.headers["x-export-secret"] };
    return { ok: true, status: 200, json: async () => ({ ok: true, registrations: [] }) };
  });
  assert.equal(ok.ok, true);
  assert.equal(seen.secret, "s".repeat(30));
  const u = new URL(seen.url);
  assert.equal(u.searchParams.get("event"), cfg.eventName);
  assert.equal(u.searchParams.get("since"), new Date(NOW - 8 * 86400000).toISOString());

  const denied = await fetchSiteRegistrations(c, NOW, async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: "unauthorized" }) }));
  assert.equal(denied.ok, false); assert.match(denied.error, /401.*unauthorized/);
  const down = await fetchSiteRegistrations(c, NOW, async () => { throw new Error("getaddrinfo ENOTFOUND"); });
  assert.equal(down.ok, false); assert.match(down.error, /unreachable/);
  const junk = await fetchSiteRegistrations(c, NOW, async () => ({ ok: true, status: 200, json: async () => ({ hello: 1 }) }));
  assert.equal(junk.ok, false);
});

test("mask: addresses never survive into logs", () => {
  assert.equal(mask("ada@example.com"), "a***@example.com");
  assert.equal(maskIn("Resend 422: The to address ada@example.com is invalid"), "Resend 422: The to address a***@example.com is invalid");
  assert.ok(!maskIn("a@b.co and long.name+tag@sub.domain.org").includes("long.name"));
});
