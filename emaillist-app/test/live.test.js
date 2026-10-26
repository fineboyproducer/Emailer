"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// These modules touch the database only inside functions the tests below never call,
// but db.js builds a pool on load, so give it a harmless URL.
process.env.SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || "postgresql://u:p@127.0.0.1:1/none";

const { liveConfig } = require("../src/live/config");
const { nextSession, sessionForDate, whenLabel } = require("../src/live/session");
const { plan, STEPS } = require("../src/live/reminders");
const { renderLiveEmail } = require("../src/live/templates");
const { cleanRegistration } = require("../src/live/register");

const cfg = liveConfig({});
// 2026-10-30 is a Friday. 8:00 PM WAT = 19:00 UTC.
const wat = (iso) => new Date(iso + "+01:00").getTime();

test("session: a midweek visitor registers for the coming Friday 8 PM WAT", () => {
  const s = nextSession(wat("2026-10-28T10:00:00"), cfg);
  assert.equal(s.dateKey, "2026-10-30");
  assert.equal(new Date(s.startMs).toISOString(), "2026-10-30T19:00:00.000Z");
  assert.equal(s.endMs - s.startMs, 60 * 60000);
});

test("session: on the Friday before the live ends, it is still today's session", () => {
  assert.equal(nextSession(wat("2026-10-30T09:00:00"), cfg).dateKey, "2026-10-30");
  assert.equal(nextSession(wat("2026-10-30T20:30:00"), cfg).dateKey, "2026-10-30"); // live in progress
});

test("session: once the live is over, it rolls to next Friday", () => {
  assert.equal(nextSession(wat("2026-10-30T21:00:00"), cfg).dateKey, "2026-11-06");
  assert.equal(nextSession(wat("2026-10-31T09:00:00"), cfg).dateKey, "2026-11-06"); // Saturday
});

test("session: a late-evening visitor outside Nigeria is judged by WAT, not their clock", () => {
  // Friday 11:30 PM WAT is Friday 22:30 UTC; the live already ended -> next week.
  assert.equal(nextSession(Date.parse("2026-10-30T22:30:00Z"), cfg).dateKey, "2026-11-06");
  // Thursday 11:30 PM WAT is Thursday 22:30 UTC -> still this Friday.
  assert.equal(nextSession(Date.parse("2026-10-29T22:30:00Z"), cfg).dateKey, "2026-10-30");
});

test("session: label reads in WAT", () => {
  assert.equal(whenLabel(sessionForDate("2026-10-30", cfg)), "Friday, October 30, 2026 at 8:00 PM WAT");
});

const reg = (over = {}) => ({
  id: 1, contact_id: 10, first_name: "Ada", email: "ada@example.com",
  registered_at: wat("2026-10-26T10:00:00"), event_date: "2026-10-30", unsubscribed_at: null, ...over,
});
const kinds = (jobs) => jobs.map((j) => j.step.kind);
const at = (iso, regs, logs = [], c = cfg) => kinds(plan(wat(iso), regs, logs, c));

test("plan: confirmation goes out right after registering, not days later", () => {
  assert.deepEqual(at("2026-10-26T10:01:00", [reg()]), ["confirm"]);
  assert.deepEqual(at("2026-10-26T14:00:00", [reg()]), []); // 4 hours on: too old to send a "you're in"
});

test("plan: 24h reminder window is Thursday 8:00 PM until before midnight", () => {
  assert.deepEqual(at("2026-10-29T19:59:00", [reg()]), []);
  assert.deepEqual(at("2026-10-29T20:00:00", [reg()]), ["24h"]);
  assert.deepEqual(at("2026-10-29T23:45:00", [reg()]), ["24h"]);
  assert.deepEqual(at("2026-10-30T00:05:00", [reg()]), []);
});

test("plan: 1h reminder and live reminder windows", () => {
  assert.deepEqual(at("2026-10-30T18:59:00", [reg()]), []);
  assert.deepEqual(at("2026-10-30T19:00:00", [reg()]), ["1h"]);
  assert.deepEqual(at("2026-10-30T19:29:00", [reg()]), ["1h"]);
  assert.deepEqual(at("2026-10-30T19:31:00", [reg()]), []);
  assert.deepEqual(at("2026-10-30T20:00:00", [reg()]), ["live"]);
  assert.deepEqual(at("2026-10-30T20:31:00", [reg()]), []);
});

test("plan: someone registering within 15 minutes of a reminder skips that reminder", () => {
  // (minutes-old registrations also have a confirmation due; look only at the timed reminders)
  const timed = (list) => list.filter((k) => k !== "confirm");
  const late = reg({ registered_at: wat("2026-10-30T18:50:00") });
  assert.deepEqual(timed(at("2026-10-30T19:05:00", [late])), []);
  const ok = reg({ registered_at: wat("2026-10-30T18:40:00") });
  assert.deepEqual(timed(at("2026-10-30T19:05:00", [ok])), ["1h"]);
});

test("plan: each registration follows its own Friday", () => {
  const next = reg({ id: 2, email: "b@example.com", event_date: "2026-11-06" });
  assert.deepEqual(at("2026-10-30T19:00:00", [reg(), next]), ["1h"]);
  assert.equal(plan(wat("2026-11-05T20:00:00"), [reg(), next], [], cfg)[0].reg.id, 2);
});

test("plan: unsubscribed, deleted-contact and invalid-email registrations get nothing", () => {
  const t = "2026-10-30T19:00:00";
  assert.deepEqual(at(t, [reg({ unsubscribed_at: "2026-10-29T00:00:00Z" })]), []);
  assert.deepEqual(at(t, [reg({ contact_id: null })]), []);
  assert.deepEqual(at(t, [reg({ email: "not-an-email" })]), []);
});

test("plan: never sends the same reminder twice, and stops retrying after 3 attempts", () => {
  const t = "2026-10-30T19:05:00";
  const log = (over) => [{ registration_id: 1, kind: "1h", status: "sent", attempts: 1, updated_at: wat("2026-10-30T19:01:00"), ...over }];
  assert.deepEqual(at(t, [reg()], log({ status: "sent" })), []);
  assert.deepEqual(at(t, [reg()], log({ status: "failed", attempts: 3 })), []);
  assert.deepEqual(at(t, [reg()], log({ status: "failed", attempts: 1 })), ["1h"]);       // retried
  assert.deepEqual(at(t, [reg()], log({ status: "pending", attempts: 1 })), []);          // another run is on it
  assert.deepEqual(at("2026-10-30T19:20:00", [reg()], log({ status: "pending", attempts: 1, updated_at: wat("2026-10-30T19:01:00") })), ["1h"]); // that run died
});

test("plan: LIVE_EMAIL_KINDS turns individual reminders off", () => {
  const only1h = liveConfig({ LIVE_EMAIL_KINDS: "1h" });
  assert.deepEqual(at("2026-10-26T10:01:00", [reg()], [], only1h), []);
  assert.deepEqual(at("2026-10-30T19:00:00", [reg()], [], only1h), ["1h"]);
});

test("plan: every step kind is one the database accepts", () => {
  assert.deepEqual(STEPS.map((s) => s.kind).sort(), ["1h", "24h", "confirm", "live"]);
});

test("email: renders for every kind, escapes names, carries the unsubscribe link", () => {
  const c = liveConfig({ APP_URL: "https://emailer.example" });
  const session = sessionForDate("2026-10-30", c);
  const unsub = "https://emailer.example/api/public/live/unsubscribe?token=abc";
  for (const step of STEPS) {
    const m = renderLiveEmail(step.kind, { first_name: '<script>alert(1)</script>' }, session, c, unsub);
    assert.ok(m.subject.length > 0);
    assert.ok(!m.html.includes("<script>"), "name must be escaped");
    assert.ok(m.html.includes(unsub) && m.text.includes(unsub));
    assert.ok(m.html.includes("https://fineboyproducer.com.ng/live/"));
    assert.ok(m.text.includes("8:00 PM WAT"));
  }
  assert.match(renderLiveEmail("24h", { first_name: "Ada" }, session, c, unsub).subject, /^Tomorrow at 8:00 PM WAT/);
});

test("register: input validation", () => {
  const good = cleanRegistration({ first_name: "  Ada  ", email: " ADA@Example.com ", whatsapp: "+234 801 234 5678", artist_name: "" });
  assert.equal(good.ok, true);
  assert.deepEqual(good.value, { firstName: "Ada", email: "ada@example.com", whatsapp: "+2348012345678", artistName: null });
  assert.equal(cleanRegistration({ first_name: "", email: "a@b.co" }).ok, false);
  assert.equal(cleanRegistration({ first_name: "Ada", email: "nope" }).ok, false);
  assert.equal(cleanRegistration({ first_name: "Ada", email: "a@b.co", whatsapp: "123" }).ok, false);
  assert.equal(cleanRegistration({ first_name: "Ada", email: "a@b.co" }).ok, true); // WhatsApp optional server-side
  assert.equal(cleanRegistration({ first_name: "x".repeat(81), email: "a@b.co" }).ok, false);
});
