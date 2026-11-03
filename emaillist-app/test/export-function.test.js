"use strict";

// Runs the website-side Edge Function (supabase-site/) in Node with a stand-in for Deno and a
// stand-in for the website's PostgREST API, to check its security and behaviour.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const canRunTs = !!(process.features && process.features.typescript);
const SECRET = "x".repeat(40);
const env = { LIVE_EXPORT_SECRET: SECRET, SUPABASE_URL: "https://website.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "eyJservice" };

let handler;
const upstream = []; // every PostgREST call the function makes
let upstreamImpl;

test.before(async () => {
  if (!canRunTs) return;
  globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(env.SUPABASE_URL)) { upstream.push({ url: String(url), headers: init && init.headers }); return upstreamImpl(String(url)); }
    return realFetch(url, init);
  };
  await import(pathToFileURL(path.join(__dirname, "..", "supabase-site", "functions", "export-live-registrations", "index.ts")).href);
});

const call = (qs = "", headers = {}, method = "GET") =>
  handler(new Request("https://fn.example/export-live-registrations" + qs, { method, headers }));
const ROWS = [{ id: "1", first_name: "Ada", email: "ada@example.com", whatsapp: "+2348012345678", artist_name: null, event_name: "E", event_date: "2026-10-30", registered_at: "2026-10-27T09:00:00Z", unsubscribed_at: null }];
const okUpstream = () => new Response(JSON.stringify(ROWS), { status: 200 });

test("export fn: refuses without the secret and with a wrong one", { skip: !canRunTs }, async () => {
  upstreamImpl = okUpstream; upstream.length = 0;
  assert.equal((await call("?event=E")).status, 401);
  assert.equal((await call("?event=E", { "x-export-secret": "wrong" })).status, 401);
  assert.equal((await call("?event=E", { "x-export-secret": SECRET.slice(0, -1) })).status, 401);
  assert.equal(upstream.length, 0, "the database is never touched without the secret");
});

test("export fn: only GET, and an event name is required", { skip: !canRunTs }, async () => {
  assert.equal((await call("?event=E", { "x-export-secret": SECRET }, "POST")).status, 405);
  assert.equal((await call("", { "x-export-secret": SECRET })).status, 400);
});

test("export fn: returns registrations read-only, without the unsubscribe token", { skip: !canRunTs }, async () => {
  upstreamImpl = okUpstream; upstream.length = 0;
  const res = await call("?event=E&since=" + encodeURIComponent(new Date(Date.now() - 3 * 86400000).toISOString()), { "x-export-secret": SECRET });
  const body = await res.json();
  assert.equal(res.status, 200); assert.equal(body.ok, true); assert.equal(body.count, 1);
  assert.equal(body.opt_outs_included, true); assert.equal(body.truncated, false);
  assert.ok(!JSON.stringify(body).includes("unsubscribe_token"));
  const u = new URL(upstream[0].url);
  assert.ok(!u.searchParams.get("select").includes("unsubscribe_token"));
  assert.equal(u.searchParams.get("event_name"), "eq.E");
  assert.equal(upstream[0].headers.apikey, "eyJservice");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("export fn: the lookback is clamped to 14 days", { skip: !canRunTs }, async () => {
  upstreamImpl = okUpstream; upstream.length = 0;
  await call("?event=E&since=2000-01-01T00:00:00Z", { "x-export-secret": SECRET });
  const gte = new URL(upstream[0].url).searchParams.get("registered_at").replace("gte.", "");
  const days = (Date.now() - Date.parse(gte)) / 86400000;
  assert.ok(days <= 14.01 && days > 13.9, `lookback was ${days} days`);
});

test("export fn: still works if the table has no unsubscribed_at column", { skip: !canRunTs }, async () => {
  upstream.length = 0;
  upstreamImpl = (url) => new URL(url).searchParams.get("select").includes("unsubscribed_at")
    ? new Response(JSON.stringify({ code: "42703" }), { status: 400 }) : okUpstream();
  const body = await (await call("?event=E", { "x-export-secret": SECRET })).json();
  assert.equal(body.ok, true); assert.equal(body.opt_outs_included, false); assert.equal(upstream.length, 2);
});

test("export fn: flags truncation and reports upstream failure", { skip: !canRunTs }, async () => {
  upstreamImpl = () => new Response(JSON.stringify(Array.from({ length: 2001 }, (_, i) => ({ id: String(i) }))), { status: 200 });
  const big = await (await call("?event=E", { "x-export-secret": SECRET })).json();
  assert.equal(big.truncated, true); assert.equal(big.count, 2000);
  upstreamImpl = () => new Response("boom", { status: 500 });
  assert.equal((await call("?event=E", { "x-export-secret": SECRET })).status, 502);
});

test("export fn: refuses to run with a missing or weak secret", { skip: !canRunTs }, async () => {
  const keep = env.LIVE_EXPORT_SECRET;
  env.LIVE_EXPORT_SECRET = "short";
  assert.equal((await call("?event=E", { "x-export-secret": "short" })).status, 500);
  env.LIVE_EXPORT_SECRET = keep;
});
