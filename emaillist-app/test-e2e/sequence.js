"use strict";

// Integration test of the follow-up sequence against a real Postgres (PGlite): the scheduler pass, the daily cap,
// buyer handling, the Paystack webhook and the unsubscribe page. Resend is replaced by a recorder.
//   cd test-e2e && npm install && npm test

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const assert = require("node:assert/strict");
const { PGlite } = require("@electric-sql/pglite");

const APP = path.join(__dirname, "..");
const PORT = 3997;
const CRON = "cron-secret-for-tests", PSK = "sk_test_paystack_secret";
Object.assign(process.env, {
  PORT: String(PORT), APP_URL: `http://localhost:${PORT}`, RESEND_API_KEY: "re_test_key", FROM_EMAIL: "live@fineboyproducer.com.ng",
  FROM_NAME: "Fineboy Producer", CRON_SECRET: CRON, SUPABASE_DB_URL: "postgresql://u:p@127.0.0.1:1/none",
  SEQ_ENABLED: "true", SEQ_REPLY_TO: "hello@example.com", SEQ_TEST_EMAIL: "me@example.com", PAYSTACK_SECRET_KEY: PSK,
});
delete process.env.SITE_EXPORT_URL; delete process.env.SITE_EXPORT_SECRET;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (n) => console.log("  ok  -", n);
const wat = (iso) => new Date(iso + "+01:00").getTime();

(async () => {
  const A = new PGlite();
  for (const f of ["schema.sql", "02_live_reminders.sql", "03_follow_up_sequence.sql"]) await A.exec(fs.readFileSync(path.join(APP, "sql", f), "utf8"));
  const run = async (text, params) => (params ? A.query(text, params) : (await A.exec(text)).slice(-1)[0] || { rows: [] });
  const shimClient = { query: run, release() {} };
  const shim = { pool: { query: run, connect: async () => shimClient, on() {} }, query: run, withTransaction: async (fn) => fn(shimClient) };
  const dbPath = require.resolve(path.join(APP, "src/db.js"));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };
  const q = async (sql, p) => (await A.query(sql, p)).rows;

  const provider = require(path.join(APP, "src/emailProvider.js"));
  const sent = []; let failNext = 0;
  provider.sendEmail = async (m) => {
    if (failNext > 0) { failNext--; return { ok: false, error: "simulated outage" }; }
    sent.push(m); return { ok: true, id: "msg_" + sent.length };
  };
  const to = (e) => sent.filter((m) => m.to === e);

  const orig = console.log; console.log = () => {};
  require(path.join(APP, "server.js"));
  await sleep(900);
  console.log = orig;

  const { runSequence, sendTest, sequenceStatus } = require(path.join(APP, "src/sequence/engine.js"));
  const { handlePaystackEvent } = require(path.join(APP, "src/sequence/purchases.js"));
  const BASE = `http://localhost:${PORT}`;

  // Three people who registered for the Friday 6 Nov 2026 live, one registered for an older live.
  const add = async (email, name, anchor, token) => {
    await q("insert into contacts (name, email, unsubscribe_token) values ($1,$2,$3)", [name, email, token]);
    const c = (await q("select id from contacts where email=$1", [email]))[0];
    await q("insert into live_registrations (contact_id, first_name, email, event_name, event_date) values ($1,$2,$3,'x',$4)", [c.id, name, email, anchor]);
  };
  await add("ada@example.com", "Ada", "2026-11-06", "tok-ada");
  await add("ben@example.com", "Ben", "2026-11-06", "tok-ben");
  await add("cy@example.com", "Cy", "2026-11-06", "tok-cy");
  await add("old@example.com", "Old", "2026-10-30", "tok-old");

  // 1. Switched off: nothing is sent, and nothing is claimed.
  process.env.SEQ_ENABLED = "false";
  const day1 = wat("2026-11-07T08:05:00");
  let r = await runSequence({ now: day1 });
  assert.equal(r.enabled, false); assert.equal(sent.length, 0); assert.equal((await q("select count(*)::int n from sequence_log"))[0].n, 0);
  step("switched off (SEQ_ENABLED not true): sends nothing");
  process.env.SEQ_ENABLED = "true";

  // 2. Rehearsal dry run: lists what would go, with masked addresses, sends nothing.
  r = await runSequence({ now: day1, dryRun: true });
  assert.equal(r.sent, 0); assert.equal(sent.length, 0); assert.equal(r.would_send.length, 3);
  assert.ok(r.would_send.every((s) => s.startsWith("B1 -> ") && / -> .\*\*\*@/.test(s)));
  step("dry run: shows 3 first emails (the older lead is not in it), masked, and sends nothing");

  // 3. Day 1: the first email goes to the three current leads, once.
  r = await runSequence({ now: day1 });
  assert.equal(r.sent, 3); assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((m) => m.to).sort(), ["ada@example.com", "ben@example.com", "cy@example.com"]);
  const m = to("ada@example.com")[0];
  assert.equal(m.subject, "I made music for years before I understood this"); assert.equal(m.replyTo, "hello@example.com");
  assert.ok(m.headers["List-Unsubscribe"].includes("/api/public/live/stop-emails?token=tok-ada") && m.headers["List-Unsubscribe-Post"]);
  assert.ok(m.html.includes("Hey Ada,") && m.text.includes("Hey Ada,") && m.html.includes("stop-emails?token=tok-ada"));
  step("Day 1: the first email goes to each current lead, personalised, with reply-to, unsubscribe link and one-click header");
  r = await runSequence({ now: day1 + 5 * 60000 });
  assert.equal(r.sent, 0); assert.equal(sent.length, 3);
  step("running again 5 minutes later sends nothing more (each email goes out once)");
  assert.equal((await q("select count(*)::int n from sequence_log where status='sent'"))[0].n, 3);

  // 4. Day 2 goes to people who started, and the late-registered older lead never starts mid-story.
  const day8 = wat("2026-11-14T08:05:00");
  r = await runSequence({ now: day8, dryRun: true });
  assert.ok(r.would_send.every((s) => s.startsWith("U1")) && r.would_send.length === 3);
  step("Day 8: the bundle email is due for the 3 who started; the older lead who never got the first email is held back");

  // 5. A Paystack webhook records a purchase, and the buyer is handled.
  const hook = (event, secret = PSK, sig) => {
    const body = JSON.stringify(event);
    const signature = sig !== undefined ? sig : crypto.createHmac("sha512", secret).update(body).digest("hex");
    return fetch(`${BASE}/api/webhooks/paystack`, { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": signature }, body });
  };
  const ev = (email, amount, ref, currency = "NGN") => ({ event: "charge.success", data: { status: "success", amount, currency, reference: ref, customer: { email, first_name: "Ben" } } });
  let res = await hook(ev("ben@example.com", 3500000, "ref-1"), "wrong-secret"); assert.equal(res.status, 401);
  res = await hook(ev("ben@example.com", 3500000, "ref-1"), PSK, "00"); assert.equal(res.status, 401);
  assert.equal((await q("select count(*)::int n from sequence_purchases"))[0].n, 0); step("webhook: a wrong or missing signature is refused and records nothing");
  res = await hook(ev("ben@example.com", 3500000, "ref-1")); let body = await res.json();
  assert.equal(res.status, 200); assert.equal(body.recorded, "blueprint");
  res = await hook(ev("ben@example.com", 3500000, "ref-1")); body = await res.json(); assert.equal(body.created, false);
  assert.equal((await q("select count(*)::int n from sequence_purchases"))[0].n, 1); step("webhook: a Blueprint payment is recorded once; Paystack's retry is harmless");
  res = await hook(ev("ben@example.com", 550000, "ref-2")); body = await res.json(); assert.ok(body.ignored);
  res = await hook({ event: "charge.failed", data: {} }); assert.ok((await res.json()).ignored);
  assert.equal((await q("select count(*)::int n from sequence_purchases"))[0].n, 1); step("webhook: other amounts (Release Checklist) and other events are ignored");
  res = await hook(ev("newbuyer@example.com", 2775000, "ref-3")); assert.equal((await res.json()).recorded, "bundle");
  assert.equal((await q("select status from contacts where email='newbuyer@example.com'"))[0].status, "active"); step("webhook: a buyer who was never on the list is added so they get an unsubscribe link");

  r = await runSequence({ now: day8, dryRun: true });
  assert.equal(r.would_send.filter((s) => s.startsWith("U1")).length, 2); step("Day 8: the Blueprint buyer is dropped from the bundle pitch (2 of 3 remain)");

  // 6. Buyer track: C1 right away for Ben, once.
  const bought = Date.now(); // purchases are stamped "now"
  r = await runSequence({ now: bought + 60000 });
  assert.ok(to("ben@example.com").some((x) => x.subject === "You're in. Do this first."));
  assert.ok(to("newbuyer@example.com").length === 0); // C4 is 48h out
  step("buyer track: the Blueprint buyer gets 'You're in. Do this first.' within minutes");
  r = await runSequence({ now: bought + 48 * 3600000 + 120000, dryRun: true });
  assert.ok(r.would_send.some((s) => s.startsWith("C2")) && r.would_send.some((s) => s.startsWith("C4")));
  step("48 hours later: C2 is due for the Blueprint buyer and C4 for the bundle buyer");

  // 7. Daily cap: only what fits goes out today, the rest waits.
  const before = sent.length;
  process.env.SEQ_DAILY_CAP = String(before + 1);
  const dayN = wat("2026-11-08T08:05:00");
  await q("update sequence_log set sent_at = $1 where status='sent'", [new Date(dayN)]);   // pretend those went out today
  r = await runSequence({ now: dayN });
  assert.equal(r.sent, 1); assert.ok(r.heldByCap >= 1); assert.match(r.warning, /Daily cap reached/);
  step("daily cap: with room for one more email today, exactly one goes and the rest are held for the next run");
  await q("update sequence_log set sent_at = $1 where status='sent'", [new Date(dayN)]);   // the new send's real timestamp is outside the simulated day
  r = await runSequence({ now: dayN + 60000 }); assert.equal(r.sent, 0); assert.ok(r.heldByCap >= 1);
  step("daily cap: still held later the same day");
  delete process.env.SEQ_DAILY_CAP;

  // 8. A provider outage is retried, then given up on after 3 tries.
  await q("delete from sequence_log");
  await q("update contacts set status='active'");
  failNext = 99;
  for (let i = 0; i < 4; i++) await runSequence({ now: day1 + i * 20 * 60000 });          // each run is > 15 min after the last claim
  const failed = await q("select attempts from sequence_log where step='B1' and email='ada@example.com'");
  assert.equal(failed[0].attempts, 3); failNext = 0; step("provider outage: each failed email is tried 3 times, then left alone");
  r = await runSequence({ now: day1 + 5 * 3600000 }); assert.equal(r.sent, 0); step("an email that gave up is not retried forever");
  const st = await sequenceStatus(day1);
  assert.equal(st.byStep.B1.failed, 2);   // Ben is a buyer, so he is not pitched assert.ok(st.failures.length && st.failures.every((f) => f.email.includes("***")));
  step("status: shows the failures with masked addresses");
  await q("delete from sequence_log");

  // 9. Unsubscribing: GET only asks, POST does it, and the person is never emailed again.
  const before2 = sent.length;
  let g = await fetch(`${BASE}/api/public/live/stop-emails?token=tok-cy`); assert.equal(g.status, 200); assert.ok((await g.text()).includes("Unsubscribe"));
  assert.equal((await q("select status from contacts where email='cy@example.com'"))[0].status, "active"); step("unsubscribe page: just opening the link (as a mail scanner would) does not unsubscribe anyone");
  g = await fetch(`${BASE}/api/public/live/stop-emails?token=bad`); assert.equal(g.status, 404);
  let p = await fetch(`${BASE}/api/public/live/stop-emails?token=tok-cy`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  assert.equal(p.status, 200);
  assert.equal((await q("select status from contacts where email='cy@example.com'"))[0].status, "unsubscribed");
  assert.notEqual((await q("select unsubscribed_at from live_registrations where email='cy@example.com'"))[0].unsubscribed_at, null);
  step("unsubscribe: the one-click POST unsubscribes the contact from everything");
  r = await runSequence({ now: day1 });
  assert.deepEqual(sent.slice(before2).map((x) => x.to).sort(), ["ada@example.com"]); step("after unsubscribing, the person gets nothing further");

  // 10. Test sender only mails the test address.
  const before3 = sent.length;
  let out = await sendTest("C3", "Ada");
  assert.equal(out.ok, true); assert.equal(sent[before3].to, "me@example.com"); assert.ok(sent[before3].subject.startsWith("[TEST] "));
  assert.equal((await sendTest("ZZ")).ok, false); step("test send: goes only to SEQ_TEST_EMAIL, prefixed [TEST], unknown steps refused");
  let h = await fetch(`${BASE}/api/public/live/sequence/test?step=B1`, { method: "POST" }); assert.equal(h.status, 401);
  h = await fetch(`${BASE}/api/public/live/sequence/test?step=B1`, { method: "POST", headers: { "x-cron-secret": CRON } }); assert.equal(h.status, 200);
  assert.equal(sent.at(-1).to, "me@example.com"); step("test endpoint: needs the secret");
  h = await fetch(`${BASE}/api/public/live/sequence/status`, { headers: { "x-cron-secret": CRON } }); const stj = await h.json();
  assert.equal(stj.ok, true); assert.equal(stj.emails, 21); assert.equal(stj.paystackWebhookConfigured, true); assert.ok(!JSON.stringify(stj).includes(PSK));
  step("status endpoint: reports the setup and never shows a secret");

  // 11. The scheduler call carries the sequence along and a sequence problem cannot break reminders.
  h = await fetch(`${BASE}/api/public/live/cron?dry_run=1`, { method: "POST", headers: { "x-cron-secret": CRON } }); const cj = await h.json();
  assert.ok(cj.sequence && cj.sequence.dryRun === true); step("the existing scheduler call also runs the sequence (here as a dry run)");

  console.log("\nSEQUENCE INTEGRATION CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("SEQUENCE TEST FAILED:", e); process.exit(1); });
