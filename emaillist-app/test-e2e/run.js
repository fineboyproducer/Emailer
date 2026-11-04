"use strict";

// End-to-end test of the live registration handoff and reminders.
//
//   cd test-e2e && npm install && npm test
//
// What is REAL: server.js and every route, the SQL (both schema files), the reminder engine,
// the reconciliation, the website-side Edge Function source (supabase-site/), the unsubscribe
// pages, and the workflow's shell script (run with curl + jq).
// What is SIMULATED: two separate Postgres databases (PGlite) standing in for the two Supabase
// projects, a small HTTP stand-in for the website project's PostgREST API, and Resend (every
// email is recorded instead of sent). Nothing here talks to Render, GitHub, Resend or Supabase,
// so it cannot prove production delivery; see docs/live-reminders-runbook.md for the live checks.

const path = require("path");
const fs = require("fs");
const http = require("http");
const os = require("os");
const { spawn } = require("child_process");
const assert = require("node:assert/strict");
const { PGlite } = require("@electric-sql/pglite");

const APP = path.join(__dirname, "..");
const PORT = 3998, REST_PORT = 4101, FN_PORT = 4102;
const SECRET = "export-secret-" + "x".repeat(30);
const CRON = "cron-secret-for-tests";
const SERVICE_KEY = "eyJ-website-service-role-key";

process.env.PORT = String(PORT);
process.env.APP_URL = `http://localhost:${PORT}`;
process.env.RESEND_API_KEY = "re_test_key";
process.env.FROM_EMAIL = "live@fineboyproducer.com.ng";
process.env.FROM_NAME = "Fineboy Producer";
process.env.CRON_SECRET = CRON;
process.env.SITE_EXPORT_URL = `http://localhost:${FN_PORT}/functions/v1/export-live-registrations`;
process.env.SITE_EXPORT_SECRET = SECRET;
process.env.SUPABASE_DB_URL = "postgresql://u:p@127.0.0.1:1/none"; // never used: the db module is replaced below

const results = [];
const step = (name) => { results.push(name); console.log("  ok  -", name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; };

(async () => {
  // ---------- two separate "Supabase projects" ----------
  const A = new PGlite(); // the Emailer's project
  const B = new PGlite(); // the website's project
  await B.exec(`
    create table public.event_registrations (
      id uuid primary key default gen_random_uuid(),
      first_name text not null, email text not null, whatsapp text not null, artist_name text,
      event_name text not null, event_date date,
      registered_at timestamptz not null default now(),
      unsubscribe_token uuid not null default gen_random_uuid(),
      unsubscribed_at timestamptz
    );
    create unique index event_registrations_email_event_date_uniq on public.event_registrations (lower(email), event_name, event_date);
  `);
  await A.exec(fs.readFileSync(path.join(APP, "sql/schema.sql"), "utf8"));

  const run = async (text, params) => (params ? A.query(text, params) : (await A.exec(text)).slice(-1)[0] || { rows: [] });
  const shimClient = { query: run, release() {} };
  const shim = {
    pool: { query: run, connect: async () => shimClient, on() {} },
    query: run,
    withTransaction: async (fn) => { await A.exec("BEGIN"); try { const r = await fn(shimClient); await A.exec("COMMIT"); return r; } catch (e) { await A.exec("ROLLBACK"); throw e; } },
  };
  const dbPath = require.resolve(path.join(APP, "src/db.js"));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim };

  const q = async (sql, p) => (await A.query(sql, p)).rows;
  const qB = async (sql, p) => (await B.query(sql, p)).rows;

  // ---------- Resend stand-in ----------
  const provider = require(path.join(APP, "src/emailProvider.js"));
  const sent = [];
  let failEmails = new Set();   // addresses whose sends fail
  let failNext = 0;             // next N sends fail (transient provider outage)
  provider.sendEmail = async (msg) => {
    if (failNext > 0) { failNext--; return { ok: false, error: `simulated Resend outage for ${msg.to}` }; }
    if (failEmails.has(msg.to)) return { ok: false, error: "simulated permanent rejection" };
    sent.push(msg);
    return { ok: true, id: "msg_" + sent.length };
  };
  const sentTo = (email) => sent.filter((m) => m.to === email);

  // ---------- website project: PostgREST stand-in + the real Edge Function ----------
  let restMode = "ok", restCalls = [], hasUnsubColumn = true;
  const rest = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    restCalls.push({ path: u.pathname, search: u.search, apikey: req.headers.apikey });
    if (!u.pathname.endsWith("/rest/v1/event_registrations")) { res.writeHead(404).end(); return; }
    if (restMode === "fail") { res.writeHead(500).end("boom"); return; }
    const cols = u.searchParams.get("select").split(",");
    if (!cols.every((c) => /^[a-z_]+$/.test(c))) { res.writeHead(400).end(); return; }
    if (cols.includes("unsubscribed_at") && !hasUnsubColumn) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ code: "42703" })); return; }
    const sel = cols.map((c) => c === "event_date" ? "to_char(event_date,'YYYY-MM-DD') as event_date"
      : c === "registered_at" || c === "unsubscribed_at" ? `to_char(${c} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') as ${c}` : c).join(",");
    const rows = (await B.query(
      `select ${sel} from public.event_registrations where event_name = $1 and registered_at >= $2::timestamptz order by registered_at asc limit ${Number(u.searchParams.get("limit"))}`,
      [u.searchParams.get("event_name").replace(/^eq\./, ""), u.searchParams.get("registered_at").replace(/^gte\./, "")])).rows;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows));
  });
  await new Promise((r) => rest.listen(REST_PORT, r));

  const denoEnv = { LIVE_EXPORT_SECRET: SECRET, SUPABASE_URL: `http://localhost:${REST_PORT}`, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY };
  let handler;
  globalThis.Deno = { env: { get: (k) => denoEnv[k] }, serve: (h) => { handler = h; } };
  await import(require("url").pathToFileURL(path.join(APP, "supabase-site/functions/export-live-registrations/index.ts")).href);
  const fn = http.createServer(async (req, res) => {
    const out = await handler(new Request(`http://localhost:${FN_PORT}${req.url}`, { method: req.method, headers: req.headers }));
    res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(await out.text());
  });
  await new Promise((r) => fn.listen(FN_PORT, r));

  // ---------- boot the real Emailer ----------
  const origLog = console.log; const logs = [];
  console.log = (...a) => { logs.push(a.join(" ")); };
  require(path.join(APP, "server.js"));
  await sleep(900);
  console.log = origLog;

  const { runReminders } = require(path.join(APP, "src/live/reminders.js"));
  const { nextSession, sessionForDate, MIN } = require(path.join(APP, "src/live/session.js"));
  const { liveConfig } = require(path.join(APP, "src/live/config.js"));
  const cfg = liveConfig();
  const S = nextSession(Date.now(), cfg);           // the Friday people registering "now" are signing up for
  const DAY = 24 * 60 * MIN;
  const BASE = `http://localhost:${PORT}/api/public/live`;
  const ORIGIN = "https://fineboyproducer.com.ng";

  const cron = async (qs = "", secret = CRON) => {
    const r = await fetch(`${BASE}/cron${qs}`, { method: "POST", headers: secret ? { "x-cron-secret": secret } : {} });
    return { status: r.status, body: await r.json() };
  };
  const push = (body) => fetch(`${BASE}/register`, { method: "POST", headers: { "Content-Type": "text/plain", Origin: ORIGIN }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const webReg = async (email, first = "Test", over = {}) => {
    const o = { event_date: S.dateKey, registered_at: null, unsubscribed_at: null, whatsapp: "+2348012345678", ...over };
    await B.query(
      `insert into public.event_registrations (first_name, email, whatsapp, event_name, event_date, registered_at, unsubscribed_at)
       values ($1,$2,$3,$4,$5, coalesce($6::timestamptz, now()), $7)`,
      [first, email, o.whatsapp, cfg.eventName, o.event_date, o.registered_at, o.unsubscribed_at]);
  };
  const regRow = async (email) => (await q("select *, to_char(event_date,'YYYY-MM-DD') as d from live_registrations where lower(email)=$1", [email]))[0];
  const tick = (ms) => runReminders({ now: S.startMs + ms });
  const T = (min) => min * MIN;

  console.log(`\nLive session under test: ${S.dateKey} (${new Date(S.startMs).toISOString()})\n`);

  // ===== 0. Startup and separation of the two projects =====
  const aTables = (await q("select table_name from information_schema.tables where table_schema='public'")).map((r) => r.table_name);
  const bTables = (await qB("select table_name from information_schema.tables where table_schema='public'")).map((r) => r.table_name);
  assert.ok(aTables.includes("live_registrations") && aTables.includes("live_reminder_log")); step("Emailer startup migration created the live tables");
  assert.ok(!aTables.includes("event_registrations") && !bTables.includes("live_registrations") && !bTables.includes("contacts"));
  step("two separate databases: no table of one exists in the other (website DB untouched by the Emailer)");

  // ===== 1. Export function: auth and shape =====
  const exp = (headers = {}, qs = `?event=${encodeURIComponent(cfg.eventName)}`) => fetch(`http://localhost:${FN_PORT}/functions/v1/export-live-registrations${qs}`, { headers });
  assert.equal((await exp()).status, 401); assert.equal((await exp({ "x-export-secret": "wrong" })).status, 401);
  assert.equal(restCalls.length, 0); step("export function refuses missing/wrong secret and never queries the website DB for them");

  // ===== 2. TEST A: successful registration =====
  await webReg("ada@example.com", "Ada", { whatsapp: "+2348011111111" });                // browser -> website Supabase
  let r = await push({ first_name: "Ada", email: "Ada@Example.com", whatsapp: "+234 801 111 1111", artist_name: "Ada B", event_name: "ignored", event_date: "1999-01-01" });
  assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.created, true);
  step("Test A: Emailer accepts the hand-off and acknowledges it (200, created)");
  assert.ok(await until(() => sentTo("ada@example.com").length === 1)); assert.match(sentTo("ada@example.com")[0].subject, /^You're in:/);
  assert.ok(sentTo("ada@example.com")[0].headers["List-Unsubscribe"].includes("/api/public/live/unsubscribe?token="));
  step("Test A: confirmation email accepted for delivery, with unsubscribe link + one-click header");
  let ada = await regRow("ada@example.com");
  assert.equal(ada.d, S.dateKey); assert.equal(ada.source, "page"); assert.equal(ada.whatsapp, "+2348011111111");
  step("Test A: registration is in the Emailer's own database; the event date was chosen by the server (client's 1999 date ignored)");
  assert.equal((await qB("select count(*)::int n from public.event_registrations"))[0].n, 1); step("Test A: website registration is intact (still 1 row)");
  const seg = await q("select s.name from contact_segments cs join segments s on s.id=cs.segment_id join contacts c on c.id=cs.contact_id where c.email='ada@example.com'");
  assert.deepEqual(seg.map((x) => x.name), ["Live Registrants"]); step("Test A: contact created and filed under 'Live Registrants'");

  // ===== 3. TEST C: duplicate requests =====
  r = await push({ first_name: "Ada", email: "ada@example.com", whatsapp: "+2348011111111" });
  assert.equal(r.body.created, false); await sleep(500);
  assert.equal((await q("select count(*)::int n from live_registrations"))[0].n, 1); assert.equal(sentTo("ada@example.com").length, 1);
  step("Test C: the same registration submitted twice -> still one row, still one confirmation");
  const bad = await push({ first_name: "X", email: "nope" }); assert.equal(bad.status, 400);
  const trap = await push({ first_name: "Bot", email: "bot@example.com", company_website: "spam" }); assert.equal(trap.body.ok, true);
  assert.equal((await q("select 1 from contacts where email='bot@example.com'")).length, 0); step("invalid input -> 400; honeypot -> fake success, nothing saved");
  r = await fetch(`${BASE}/register`, { method: "OPTIONS", headers: { Origin: ORIGIN } }); assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  r = await fetch(`${BASE}/health`, { headers: { Origin: "https://evil.example" } }); assert.equal(r.headers.get("access-control-allow-origin"), null);
  step("CORS: site origin allowed, others not");

  // ===== 4. TEST B: failed hand-off (Emailer never heard about Ben) =====
  await webReg("ben@example.com", "Ben");
  assert.equal(await regRow("ben@example.com"), undefined);
  let c = await cron(); assert.equal(c.status, 200);
  assert.equal(c.body.reconcile.imported, 1); assert.equal(c.body.healthy, true);
  ben = await regRow("ben@example.com"); assert.equal(ben.source, "sync"); assert.equal(ben.d, S.dateKey);
  assert.equal(sentTo("ben@example.com").length, 1); assert.match(sentTo("ben@example.com")[0].subject, /^You're in:/);
  step("Test B: registration whose hand-off never happened is imported on the next scheduler run, and confirmed");
  const lastCall = restCalls.at(-1); assert.equal(lastCall.apikey, SERVICE_KEY); assert.ok(!JSON.stringify(restCalls).includes("unsubscribe_token"));
  step("the export function reads with its own key, and never selects unsubscribe_token");
  assert.equal((await qB("select count(*)::int n from public.event_registrations"))[0].n, 2); step("Test B: website registrations remain intact after reconciliation");
  r = await push({ first_name: "Ben", email: "ben@example.com", whatsapp: "+2348012345678" });
  assert.equal(r.body.created, false); await sleep(400); assert.equal(sentTo("ben@example.com").length, 1);
  step("Test B: the browser's late retry arriving after reconciliation creates nothing new");
  c = await cron(); assert.equal(c.body.reconcile.imported, 0); assert.ok(c.body.reconcile.alreadyThere >= 2); assert.equal(c.body.sent, 0);
  step("Test C: reconciling again is a no-op (nothing imported, nothing sent)");

  // ===== 5. Consistency and bad data =====
  await webReg("cy@example.com", "Cy", { event_date: "2025-01-03" });                   // page with a wrong device clock
  await webReg("not-an-email", "Bad");
  await webReg("old@example.com", "Old", { registered_at: new Date(Date.now() - 12 * DAY).toISOString() });
  await webReg("stale@example.com", "Stale", { registered_at: new Date(S.startMs - 8 * DAY).toISOString() });
  c = await cron();
  assert.equal(c.body.reconcile.imported, 1); assert.equal(c.body.reconcile.dateMismatch, 1); assert.equal(c.body.reconcile.invalid, 1); assert.equal(c.body.reconcile.stale, 1);
  assert.equal((await regRow("cy@example.com")).d, S.dateKey); assert.equal(await regRow("old@example.com"), undefined); assert.equal(await regRow("stale@example.com"), undefined);
  step("wrong website event_date -> imported on the server-computed Friday and counted as a mismatch");
  step("invalid row counted and skipped; 12-day-old row outside the window; row for a finished live skipped, never scheduled");
  assert.ok(!JSON.stringify(c.body).match(/[a-z]+@example/), "no raw email in the run summary"); step("run summary contains no raw email addresses (safe for public Actions logs)");

  // ===== 6. Website export outage =====
  restMode = "fail"; await webReg("dee@example.com", "Dee");
  c = await cron(); assert.equal(c.status, 200); assert.equal(c.body.healthy, false); assert.equal(c.body.reconcile.ok, false); assert.match(c.body.reconcile.error, /502|failed/);
  assert.equal(await regRow("dee@example.com"), undefined); step("website export down -> run reports unhealthy (the Actions run would go red); nothing is lost");
  restMode = "ok"; c = await cron(); assert.equal(c.body.healthy, true); assert.equal(c.body.reconcile.imported, 1); assert.equal(sentTo("dee@example.com").length, 1);
  step("website export back -> the missed registration is imported and confirmed automatically");

  // ===== 7. Opt-outs travel from the website =====
  await B.query("update public.event_registrations set unsubscribed_at = now() where email = 'ada@example.com'");
  await webReg("eve@example.com", "Eve", { unsubscribed_at: new Date().toISOString() });
  const before = sent.length; c = await cron();
  assert.equal(c.body.reconcile.optOutsApplied, 1); assert.ok((await regRow("ada@example.com")).unsubscribed_at);
  assert.ok((await regRow("eve@example.com")).unsubscribed_at); assert.equal(sent.length, before);
  step("a website opt-out is applied to a known registrant; an already-opted-out newcomer is stored but never emailed");
  await B.query("update public.event_registrations set unsubscribed_at = null where email = 'ada@example.com'");
  await cron(); assert.ok((await regRow("ada@example.com")).unsubscribed_at); step("an opt-out is never cleared by a later import");

  // ===== 8. Dry run =====
  await webReg("fay@example.com", "Fay");
  const dry = await cron("?dry_run=1");
  assert.equal(dry.body.dryRun, true); assert.equal(dry.body.reconcile.wouldImport, 1); assert.ok(dry.body.would_send.includes("confirm -> f***@example.com"));
  assert.equal(await regRow("fay@example.com"), undefined); assert.ok(!sentTo("fay@example.com").length);
  step("dry run: shows the import and the emails it would trigger (masked), writes and sends nothing");
  await cron(); assert.equal(sentTo("fay@example.com").length, 1);

  // ===== 9. Auth on scheduler + status =====
  assert.equal((await cron("", null)).status, 401); assert.equal((await cron("", "wrong")).status, 401); step("scheduler endpoint refuses missing/wrong secret");
  assert.equal((await fetch(`${BASE}/status`)).status, 401);
  const st = await (await fetch(`${BASE}/status`, { headers: { "x-cron-secret": CRON } })).json();
  assert.equal(st.nextLive.date, S.dateKey); assert.ok(st.registrations.total >= 6); assert.ok(st.reminders.confirm.sent >= 5);
  assert.ok(!JSON.stringify(st).match(/[a-z]+@example/)); step("status endpoint: protected, correct counts, emails masked");

  // ===== 10. Unsubscribe (Dee, via the page; Ben via mail-app one-click) =====
  const tokenOf = async (e) => (await q("select unsubscribe_token t from contacts where email=$1", [e]))[0].t;
  const dee = await tokenOf("dee@example.com");
  r = await fetch(`${BASE}/unsubscribe?token=${dee}`); assert.equal(r.status, 200); assert.match(await r.text(), /Stop the reminders\?/);
  assert.equal((await regRow("dee@example.com")).unsubscribed_at, null); step("Test F: opening the unsubscribe link (as a mail scanner would) changes nothing");
  assert.equal((await fetch(`${BASE}/unsubscribe?token=nope`)).status, 404);
  assert.equal((await fetch(`${BASE}/unsubscribe?token=${"a".repeat(500)}`)).status, 404); step("unknown / oversized tokens -> 404");
  r = await fetch(`${BASE}/unsubscribe?token=${dee}`, { method: "POST" }); assert.match(await r.text(), /You(?:'|&#39;)re unsubscribed/);
  const t1 = (await regRow("dee@example.com")).unsubscribed_at; assert.ok(t1);
  await fetch(`${BASE}/unsubscribe?token=${dee}`, { method: "POST" }); assert.equal(String((await regRow("dee@example.com")).unsubscribed_at), String(t1)); step("Test F: confirming unsubscribes; repeating it is harmless (idempotent)");
  assert.equal((await q("select status from contacts where email='dee@example.com'"))[0].status, "active"); assert.ok(await regRow("dee@example.com")); step("Test F: registration history kept; campaign subscription status untouched");
  assert.equal((await regRow("fay@example.com")).unsubscribed_at, null); step("one person's token cannot change another's subscription");
  const ben2 = await tokenOf("ben@example.com");
  r = await fetch(`${BASE}/unsubscribe?token=${ben2}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  assert.equal(await r.text(), "Unsubscribed."); assert.ok((await regRow("ben@example.com")).unsubscribed_at); step("mail apps' one-click unsubscribe works");
  await B.query("update public.event_registrations set unsubscribed_at = null"); // (website flags irrelevant from here)

  // ===== 11. TEST D / G: the schedule, in WAT, for the real Friday =====
  // Everyone still opted in (Cy, Fay) registered 5 days before the live; Ada, Ben, Dee, Eve are opted out.
  const when = new Date(S.startMs - 5 * DAY).toISOString();
  await q("update live_registrations set registered_at=$1", [when]); await B.query("update public.event_registrations set registered_at=$1 where email not in ('old@example.com','stale@example.com','not-an-email')", [when]);   // leave the deliberately old / stale / invalid rows alone
  const base = sent.length;
  let s = await tick(T(-25 * 60)); assert.equal(s.sent, 0); step("Test D: 25h before -> nothing due");
  restMode = "fail";   // the website export is down during the 24h reminder: known registrants must still be reminded
  s = await tick(T(-24 * 60 + 1)); assert.equal(s.sent, 2); assert.equal(s.healthy, false);
  assert.equal(s.warnings.length, 1); assert.match(s.warnings[0], new RegExp("No Google Meet link is set for " + S.dateKey));
  assert.ok(sent.slice(base).every((m) => !m.html.includes("meet.google.com") && !m.text.includes("meet.google.com")));
  step("Meet link: none set yet -> the run warns (naming the Friday) and no email mentions a link");
  assert.deepEqual(sent.slice(base).map((m) => m.to).sort(), ["cy@example.com", "fay@example.com"]);
  assert.ok(sent.slice(base).every((m) => /^Tomorrow at 8:00 PM WAT/.test(m.subject) && m.html.includes("Friday")));
  step("Test G: Thursday 8:00 PM WAT -> 'Tomorrow at 8:00 PM WAT' to the two opted-in registrants only (opted-out excluded)");
  step("reminders still go out while the website export is down (the run is flagged unhealthy)"); restMode = "ok";
  s = await tick(T(-24 * 60 + 7)); assert.equal(s.sent, 0); step("Test D: the next run, and any repeat, sends nothing again");
  s = await tick(T(-60 - 1)); assert.equal(s.sent, 0); step("Test D: 61 min before -> the 1h reminder is not sent early");
  failNext = 1; s = await tick(T(-60 + 1)); assert.equal(s.failed, 1); assert.equal(s.sent, 1); assert.equal(s.healthy, false);
  assert.equal((await q("select count(*)::int n from live_reminder_log where kind='1h' and status='failed'"))[0].n, 1); step("Test E: a transient provider failure is recorded as failed (and flagged)");
  s = await tick(T(-60 + 7)); assert.equal(s.sent, 1); assert.match(sent.at(-1).subject, /^Tonight at 8:00 PM WAT/);
  assert.equal((await q("select count(*)::int n from live_reminder_log where kind='1h' and status='sent'"))[0].n, 2); step("Test E: the failed reminder is retried on the next run and delivered exactly once");
  // permanent rejection of one address at 'live' time: bounded retries
  const MEET = "https://meet.google.com/abc-defg-hij";
  await q("insert into live_meet_links (event_date, url) values ($1, $2)", [S.dateKey, MEET]);
  failEmails = new Set(["cy@example.com"]);
  const beforeLive = sent.length;
  s = await tick(T(1)); assert.equal(s.sent, 1); assert.equal(s.failed, 1);
  assert.deepEqual(s.warnings, []);
  const liveMail = sent.slice(beforeLive).find((m) => m.to === "fay@example.com");
  assert.match(liveMail.subject, /^We're live now/); assert.ok(liveMail.html.includes(`href="${MEET}"`) && liveMail.html.includes(">Join on Google Meet<") && liveMail.text.includes(MEET));
  step("Meet link: once added, the 'live now' email carries a Join button and the link, and the warning clears");
  const stNow = await require(path.join(APP, "src/live/status.js")).liveStatus(S.startMs - 3600000);   // the same function /status serves, at the test's pretend time
  assert.equal(stNow.meetLinkSet, true); assert.ok(!JSON.stringify(stNow).includes("meet.google.com"));
  step("Meet link: /status says it is set but never shows the link");
  const dryOut = await (await fetch(`${BASE}/cron?dry_run=1`, { method: "POST", headers: { "x-cron-secret": CRON } })).text();
  assert.ok(!dryOut.includes("meet.google.com"));
  step("Meet link: not in the scheduler's output either (that output is printed on a public GitHub page)");
  s = await tick(T(6)); assert.equal(s.failed, 1);
  s = await tick(T(11)); assert.equal(s.failed, 1);
  s = await tick(T(16)); assert.equal(s.failed, 0); assert.equal(s.sent, 0);
  const capped = (await q("select l.attempts, l.status from live_reminder_log l join live_registrations r on r.id=l.registration_id where r.email='cy@example.com' and l.kind='live'"))[0];
  assert.equal(capped.attempts, 3); assert.equal(capped.status, "failed"); step("Test E: a permanently rejected address is tried 3 times then left alone");
  failEmails = new Set();
  s = await tick(T(31)); assert.equal(s.sent, 0); step("Test G: 31 min after the start -> the 'live now' window has closed; no stale reminders");
  const perPerson = await q("select r.email, array_agg(l.kind order by l.kind) kinds from live_reminder_log l join live_registrations r on r.id=l.registration_id where l.status='sent' group by r.email order by 1");
  const got = Object.fromEntries(perPerson.map((x) => [x.email, x.kinds]));
  assert.deepEqual(got["fay@example.com"], ["1h", "24h", "confirm", "live"]); assert.deepEqual(got["cy@example.com"], ["1h", "24h", "confirm"]);
  assert.deepEqual(got["ben@example.com"], ["confirm"]); assert.deepEqual(got["dee@example.com"], ["confirm"]); assert.deepEqual(got["ada@example.com"], ["confirm"]);
  assert.equal((await q("select count(*)::int n from (select registration_id, kind from live_reminder_log group by 1,2 having count(*)>1) x"))[0].n, 0);
  step("log check: exactly one of each reminder per person; opted-out people only ever got their confirmation");
  assert.deepEqual(sent.map((m) => m.to).filter((e) => e === "eve@example.com"), []); step("someone who arrived already opted out received nothing at all");

  // ===== 12. Next Friday, and a late registrant =====
  const nextFri = sessionForDate(new Date(S.startMs + 7 * DAY + 3600000).toISOString().slice(0, 10), cfg);
  await webReg("late@example.com", "Late", { event_date: nextFri.dateKey, registered_at: new Date(S.startMs + 2 * 3600000).toISOString() });
  const lateNow = S.startMs + 3 * 3600000; // live over; registered at 10 PM
  await runReminders({ now: lateNow });
  const lateRow = await regRow("late@example.com"); assert.equal(lateRow.d, nextFri.dateKey);
  assert.equal(sentTo("late@example.com").length, 1); assert.match(sentTo("late@example.com")[0].subject, /^You're in:/);
  step("Test G: someone registering after the live ends is put on the NEXT Friday and gets only a confirmation (no stale reminders)");

  // ===== 13. Workflow script (the real YAML, run with real curl + jq) =====
  const yaml = fs.readFileSync(path.join(APP, "..", ".github/workflows/live-reminders.yml"), "utf8");
  const script = yaml.split("run: |\n")[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  // Async on purpose: the Emailer under test runs in THIS process, so a blocking spawnSync would freeze it.
  const runWorkflow = (env) => new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-"));
    const p = spawn("bash", ["-e", "-c", script], { cwd: dir, env: { PATH: process.env.PATH, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d)); p.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => p.kill(), 100000);
    p.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  let w = await runWorkflow({ EMAILER_URL: `http://localhost:${PORT}`, CRON_SECRET: CRON }); assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.ok(!w.stdout.match(/[a-z]+@example/)); step("workflow script: healthy run -> exit 0, and nothing in its output reveals an email address");
  restMode = "fail"; w = await runWorkflow({ EMAILER_URL: `http://localhost:${PORT}`, CRON_SECRET: CRON }); assert.notEqual(w.status, 0); assert.match(w.stderr, /reported a problem/);
  restMode = "ok"; step("workflow script: a run that cannot read the website -> exit 1 (Actions goes red)");
  w = await runWorkflow({ EMAILER_URL: `http://localhost:${PORT}`, CRON_SECRET: "wrong" }); assert.notEqual(w.status, 0); assert.match(w.stderr, /401/); step("workflow script: wrong secret -> exit 1");
  w = await runWorkflow({ EMAILER_URL: "", CRON_SECRET: "" }); assert.notEqual(w.status, 0); step("workflow script: missing repository secrets -> exit 1 with a clear message");

  // ===== 14. Production start: a separate process, as Render runs it =====
  const child = spawn(process.execPath, ["server.js"], { cwd: APP, env: { PATH: process.env.PATH, PORT: "3997", NODE_ENV: "production", SUPABASE_DB_URL: "postgresql://u:p@127.0.0.1:1/none", APP_URL: "http://localhost:3997" } });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  assert.ok(await until(async () => { try { return (await fetch("http://localhost:3997/api/public/live/health")).ok; } catch { return false; } }, 8000), out);
  const noSecret = await fetch("http://localhost:3997/api/public/live/cron", { method: "POST", headers: { "x-cron-secret": "x" } });
  assert.equal(noSecret.status, 500); assert.match((await noSecret.json()).error, /CRON_SECRET is not set/);
  child.kill(); step(`production-style start (node server.js, NODE_ENV=production, Node ${process.version}): serves /health; refuses the scheduler when CRON_SECRET is unset`);

  console.log(`\nALL ${results.length} END-TO-END CHECKS PASSED`);
  process.exit(0);
})().catch((e) => { console.error("\nE2E FAILED:", e); process.exit(1); });

let ben; // (assigned in the Test B block)
