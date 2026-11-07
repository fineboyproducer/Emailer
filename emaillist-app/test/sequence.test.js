"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

process.env.SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || "postgresql://u:p@127.0.0.1:1/none";

const { sequenceConfig, parseAmounts } = require("../src/sequence/config");
const { loadSteps, parseSteps } = require("../src/sequence/content");
const { render } = require("../src/sequence/render");
const { plan, watMidnightMs, watDayStartMs } = require("../src/sequence/engine");
const { verifyPaystackSignature, productForAmount } = require("../src/sequence/purchases");

const cfg = sequenceConfig({ APP_URL: "https://emailer.example" });
const steps = loadSteps();
const wat = (iso) => new Date(iso + "+01:00").getTime();
const lead = (over = {}) => ({ email: "ada@example.com", name: "Ada", token: "tok", anchor: "2026-11-06", ...over });
const input = (over = {}) => ({ leads: [lead()], purchases: [], buyers: new Map(), logs: [], ...over });
const ids = (jobs) => jobs.map((j) => j.step.id);
const sentLog = (step, email = "ada@example.com") => ({ email, step, status: "sent", attempts: 1, updated_at: new Date() });

test("content: all 21 emails parse, with the expected tracks and days", () => {
  assert.equal(steps.length, 21);
  assert.equal(new Set(steps.map((s) => s.id)).size, 21);
  const lead = steps.filter((s) => s.track === "lead").map((s) => `${s.id}:${s.n}`).join(" ");
  assert.equal(lead, "B1:1 B2:2 B3:3 B4:4 B5:5 B6:6 U1:8 U2:10 U3:12 U4:14 A1:15 A2:17 A3:19 A4:21");
  assert.deepEqual(steps.filter((s) => s.track === "long").map((s) => s.id), ["N1", "N2", "N3"]);
  assert.deepEqual(steps.filter((s) => s.track === "buyer-blueprint").map((s) => `${s.id}:${s.n}`), ["C1:0", "C2:48", "C3:120"]);
  assert.deepEqual(steps.filter((s) => s.track === "buyer-bundle").map((s) => s.id), ["C4"]);
});

test("content: no unfilled placeholders, no banned phrases, every link is https on a known host", () => {
  const hosts = new Set(["fineboyproducer.com.ng", "t.me"]);
  for (const s of steps) {
    const all = `${s.subject}\n${s.preview}\n${s.body}`;
    assert.ok(!/\[[A-Z][A-Z ,:]{3,}/.test(all), `${s.id}: leftover bracketed placeholder`);
    assert.ok(!/unlock your full potential|next level|TBD|TODO/i.test(all), `${s.id}: banned phrase`);
    assert.ok(s.body.includes("{{name}}"), `${s.id}: greets by name`);
    assert.ok(s.subject.length <= 70, `${s.id}: subject length ${s.subject.length}`);
    for (const m of s.body.matchAll(/\]\((.*?)\)/g)) {
      const u = new URL(m[1]);
      assert.equal(u.protocol, "https:", `${s.id}: ${m[1]}`);
      assert.ok(hosts.has(u.hostname), `${s.id}: unexpected host ${u.hostname}`);
    }
  }
  // every sales link carries a campaign tag, so sales can be traced back to the email
  for (const s of steps.filter((x) => x.track !== "buyer-blueprint" || x.id !== "C1")) {
    for (const m of s.body.matchAll(/\]\((https:\/\/fineboyproducer\.com\.ng\/(?:blueprint|access|work%20with%20me|live)\/\?[^)]*)\)/g)) {
      assert.ok(m[1].includes(`utm_campaign=${s.id.toLowerCase()}`), `${s.id}: link tag`);
    }
  }
});

test("content: a malformed email is refused loudly", () => {
  assert.throws(() => parseSteps("=== X1 | lead | day 1 ===\nSubject: Hi\n\nbody"), /Preview/);
  assert.throws(() => parseSteps("=== X1 | lead | day 1 ===\nSubject: Hi\nPreview: p\n"), /empty body/);
});

test("render: first name only, HTML escaped, links kept, unsubscribe present, preview hidden", () => {
  const s = steps.find((x) => x.id === "B1");
  const m = render(s, { name: '<img src=x onerror=alert(1)> Ada' }, "https://emailer.example/api/public/live/stop-emails?token=t");
  assert.ok(!m.html.includes("<img"), "name cannot inject markup");
  assert.ok(m.text.startsWith("Hey &lt;img") || m.text.startsWith("Hey <img"), "first word only is used");
  const ok = render(s, { name: "Ada Lovelace" }, "https://emailer.example/u?token=t");
  assert.ok(ok.text.startsWith("Hey Ada,"));
  assert.ok(ok.html.includes('href="https://fineboyproducer.com.ng/blueprint/?utm_source=email&amp;utm_campaign=b1"'));
  assert.ok(ok.text.includes("Get the Blueprint → (https://fineboyproducer.com.ng/blueprint/?utm_source=email&utm_campaign=b1)"));
  assert.ok(ok.html.includes("Unsubscribe") && ok.text.includes("Unsubscribe: https://emailer.example/u?token=t"));
  assert.ok(ok.html.includes("display:none") && ok.html.includes(s.preview));
  assert.ok(!/<script|<img|<iframe/i.test(ok.html));
  assert.ok(render(s, { name: "" }, "u").text.startsWith("Hey there,"));
  assert.ok(render(s, { name: "A" }, "u", { subjectPrefix: "[TEST] " }).subject.startsWith("[TEST] "));
});

test("render: lists and bold come out as real lists and bold", () => {
  const b2 = render(steps.find((x) => x.id === "B2"), { name: "Ada" }, "u");
  assert.ok(b2.html.includes("<ul") && b2.html.includes("<ol") && b2.html.includes("<strong>Clarity.</strong>"));
  assert.ok(b2.text.includes("- Releasing music with no long-term direction.") && b2.text.includes("1. Clarity. Know where you're going and why."));
});

test("timing: WAT midnight and the WAT day boundary are exact", () => {
  assert.equal(new Date(watMidnightMs("2026-11-06")).toISOString(), "2026-11-05T23:00:00.000Z");
  assert.equal(new Date(watDayStartMs(Date.parse("2026-11-07T22:59:00Z"))).toISOString(), "2026-11-06T23:00:00.000Z");
  assert.equal(new Date(watDayStartMs(Date.parse("2026-11-07T23:00:00Z"))).toISOString(), "2026-11-07T23:00:00.000Z");
});

test("plan: Day 1 email goes out from 8 AM WAT the day after the live, not before, not much later", () => {
  assert.deepEqual(ids(plan(wat("2026-11-07T07:59:00"), input(), cfg)), []);
  assert.deepEqual(ids(plan(wat("2026-11-07T08:00:00"), input(), cfg)), ["B1"]);
  assert.deepEqual(ids(plan(wat("2026-11-08T13:59:00"), input(), cfg)), ["B1"], "still inside the 30h catch-up window");
  assert.deepEqual(ids(plan(wat("2026-11-08T14:00:00"), input(), cfg)), [], "window closed: skipped, never sent at a silly time");
  assert.deepEqual(ids(plan(wat("2026-11-06T20:00:00"), input(), cfg)), [], "nothing on the live day itself");
});

test("plan: each day brings its own email, in order", () => {
  const started = input({ logs: [sentLog("B1")] });
  assert.deepEqual(ids(plan(wat("2026-11-08T08:30:00"), started, cfg)), ["B2"]);
  assert.deepEqual(ids(plan(wat("2026-11-14T08:30:00"), started, cfg)), ["U1"], "Day 8");
  assert.deepEqual(ids(plan(wat("2026-11-21T08:30:00"), input({ logs: [sentLog("B1"), sentLog("U4")] }), cfg)), ["A1"], "Day 15");
  assert.deepEqual(ids(plan(wat("2026-12-04T08:30:00"), started, cfg)), ["N1"], "Day 28");
});

test("plan: someone whose first email never went out never receives a mid-story email", () => {
  assert.deepEqual(ids(plan(wat("2026-11-14T08:30:00"), input(), cfg)), [], "U1 held back: B1 was never sent");
  assert.deepEqual(ids(plan(wat("2026-11-14T08:30:00"), input({ logs: [{ ...sentLog("B1"), status: "failed", attempts: 3 }] }), cfg)), []);
});

test("plan: a buyer leaves the sales emails but keeps the long tail, and gets the buyer track", () => {
  const bought = { email: "ada@example.com", product: "blueprint", atMs: wat("2026-11-07T10:00:00") };
  const buyers = new Map([["ada@example.com", { name: "Ada", token: "tok" }]]);
  const base = input({ logs: [sentLog("B1")], purchases: [bought], buyers });
  assert.ok(!ids(plan(wat("2026-11-08T08:30:00"), base, cfg)).includes("B2"), "B2 skipped for a buyer");
  assert.deepEqual(ids(plan(wat("2026-11-07T10:05:00"), base, cfg)), ["C1"]);
  assert.deepEqual(ids(plan(wat("2026-11-09T10:05:00"), base, cfg)), ["C2"], "48 hours after");
  assert.deepEqual(ids(plan(wat("2026-11-12T10:05:00"), base, cfg)), ["C3"], "120 hours after");
  assert.deepEqual(ids(plan(wat("2026-12-05T08:30:00"), base, cfg)), ["N1"], "no pitch, so a buyer still gets it");
  assert.deepEqual(ids(plan(wat("2026-11-07T10:05:00"), { ...base, buyers: new Map() }, cfg)), [], "an unsubscribed buyer gets nothing");
});

test("plan: a bundle buyer gets C4 two days later; an AGI buyer gets no buyer email", () => {
  const buyers = new Map([["ada@example.com", { name: "Ada", token: "tok" }]]);
  const bundle = input({ leads: [], buyers, purchases: [{ email: "ada@example.com", product: "bundle", atMs: wat("2026-11-07T10:00:00") }] });
  assert.deepEqual(ids(plan(wat("2026-11-09T10:05:00"), bundle, cfg)), ["C4"]);
  const agi = input({ leads: [], buyers, purchases: [{ email: "ada@example.com", product: "agi", atMs: wat("2026-11-07T10:00:00") }] });
  assert.deepEqual(ids(plan(wat("2026-11-09T10:05:00"), agi, cfg)), []);
});

test("plan: sent emails are never repeated; failures retry up to 3 times; a fresh claim is respected", () => {
  const now = wat("2026-11-07T08:30:00");
  assert.deepEqual(ids(plan(now, input({ logs: [sentLog("B1")] }), cfg)), []);
  assert.deepEqual(ids(plan(now, input({ logs: [{ ...sentLog("B1"), status: "failed", attempts: 2 }] }), cfg)), ["B1"]);
  assert.deepEqual(ids(plan(now, input({ logs: [{ ...sentLog("B1"), status: "failed", attempts: 3 }] }), cfg)), []);
  assert.deepEqual(ids(plan(now, input({ logs: [{ ...sentLog("B1"), status: "pending", updated_at: new Date(now - 2 * 60000) }] }), cfg)), [], "another run is on it");
  assert.deepEqual(ids(plan(now, input({ logs: [{ ...sentLog("B1"), status: "pending", updated_at: new Date(now - 20 * 60000) }] }), cfg)), ["B1"], "a crashed run's claim is retaken");
});

test("plan: rehearsal mode sends to one address only", () => {
  const two = input({ leads: [lead(), lead({ email: "bob@example.com" })] });
  const rehearsal = sequenceConfig({ SEQ_ONLY_EMAIL: "BOB@example.com" });
  assert.deepEqual(plan(wat("2026-11-07T08:30:00"), two, rehearsal).map((j) => j.email), ["bob@example.com"]);
});

test("config: off unless explicitly enabled; amounts parse to kobo", () => {
  assert.equal(sequenceConfig({}).enabled, false);
  assert.equal(sequenceConfig({ SEQ_ENABLED: "true" }).enabled, true);
  assert.equal(sequenceConfig({ SEQ_ENABLED: "false" }).enabled, false);
  assert.deepEqual(parseAmounts(""), { blueprint: 3500000, bundle: 2775000, agi: 9970000 });
  assert.deepEqual(parseAmounts("agi:120000,junk:5"), { agi: 12000000 });
  assert.equal(sequenceConfig({}).dailyCap, 80);
});

test("paystack: signature check and product mapping", () => {
  const body = Buffer.from('{"event":"charge.success"}');
  const sig = crypto.createHmac("sha512", "sk_test_x").update(body).digest("hex");
  assert.equal(verifyPaystackSignature(body, sig, "sk_test_x"), true);
  assert.equal(verifyPaystackSignature(body, sig.toUpperCase(), "sk_test_x"), true);
  assert.equal(verifyPaystackSignature(body, sig, "other"), false);
  assert.equal(verifyPaystackSignature(body, "", "sk_test_x"), false);
  assert.equal(verifyPaystackSignature(Buffer.from("{}"), sig, "sk_test_x"), false, "a changed body fails");
  assert.equal(verifyPaystackSignature(body, sig, ""), false, "no secret configured refuses everything");
  assert.equal(productForAmount(3500000, "NGN", cfg), "blueprint");
  assert.equal(productForAmount(2775000, "NGN", cfg), "bundle");
  assert.equal(productForAmount(9970000, "NGN", cfg), "agi");
  assert.equal(productForAmount(550000, "NGN", cfg), null, "the Release Checklist is not one of the three");
  assert.equal(productForAmount(3500000, "USD", cfg), null);
});
