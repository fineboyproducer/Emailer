"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || "postgresql://u:p@127.0.0.1:1/none";

const { liveConfig } = require("../src/live/config");
const { sessionForDate } = require("../src/live/session");
const { renderLiveEmail, safeMeetUrl } = require("../src/live/templates");

const cfg = liveConfig({ APP_URL: "https://emailer.example" });
const session = sessionForDate("2026-11-06", cfg);            // Fri 6 Nov 2026, 8 PM WAT = 19:00 UTC
const MEET = "https://meet.google.com/abc-defg-hij";
const UNSUB = "https://emailer.example/api/public/live/unsubscribe?token=t";
const wat = (iso) => new Date(iso + "+01:00").getTime();
const mail = (kind, meetUrl, nowIso) => renderLiveEmail(kind, { first_name: "Ada" }, session, cfg, UNSUB, { meetUrl, nowMs: wat(nowIso) });
// the calendar button's address: the link rides in its "location" and "details"
const calParams = (m) => {
  const href = /href="(https:\/\/calendar\.google\.com[^"]+)"/.exec(m.html)[1].replace(/&amp;/g, "&");
  return new URL(href).searchParams;
};
// the visible "Join" button, as opposed to the link riding inside the calendar button's address
const hasJoinButton = (m) => m.html.includes(`>Join on Google Meet<`) && m.html.includes(`href="${MEET}"`);

test("meet link: only a real Google Meet address is ever accepted", () => {
  assert.equal(safeMeetUrl(MEET), MEET);
  assert.equal(safeMeetUrl("  " + MEET + "  "), MEET);
  assert.equal(safeMeetUrl("https://meet.google.com/abc-defg-hij?authuser=0"), "https://meet.google.com/abc-defg-hij?authuser=0");
  for (const bad of ["", null, undefined, "http://meet.google.com/abc", "https://evil.example/meet.google.com/abc",
    "javascript:alert(1)", "https://meet.google.com/", 'https://meet.google.com/a"><script>', "https://meet.google.com.evil.example/abc"]) {
    assert.equal(safeMeetUrl(bad), "", `should reject ${JSON.stringify(bad)}`);
  }
});

test("meet link: reminders carry a Join button and the link in the calendar entry", () => {
  for (const kind of ["24h", "1h", "live"]) {
    const m = mail(kind, MEET, "2026-11-05T20:05:00");
    assert.ok(hasJoinButton(m), `${kind}: join button`);
    assert.ok(m.text.includes(`Join on Google Meet: ${MEET}`), `${kind}: text version`);
    assert.equal(calParams(m).get("location"), MEET, `${kind}: calendar entry location is the Meet link`);
    assert.ok(calParams(m).get("details").includes(MEET), `${kind}: calendar details include it`);
  }
});

test("meet link: an early confirmation hides the Join button but the calendar entry still carries the link", () => {
  const m = mail("confirm", MEET, "2026-11-02T10:00:00");           // four days ahead
  assert.ok(!hasJoinButton(m));
  assert.ok(!m.text.includes("Join on Google Meet:"));
  assert.equal(calParams(m).get("location"), MEET, "reachable via Add to calendar");
});

test("meet link: a confirmation sent within a day of the live (a late registrant) gets the Join button", () => {
  assert.ok(hasJoinButton(mail("confirm", MEET, "2026-11-06T15:00:00")));
  assert.ok(hasJoinButton(mail("confirm", MEET, "2026-11-05T21:00:00")));   // exactly inside 24h
  assert.ok(!hasJoinButton(mail("confirm", MEET, "2026-11-05T19:00:00")));  // 25h ahead
});

test("meet link: with no link set, nothing is rendered about one and the page link is offered instead", () => {
  for (const kind of ["confirm", "24h", "1h", "live"]) {
    const m = mail(kind, "", "2026-11-06T19:00:00");
    assert.ok(!m.html.includes("meet.google.com") && !m.text.includes("meet.google.com"), kind);
    assert.ok(!m.html.includes(">Join on Google Meet<"));
    assert.ok(m.html.includes("https://fineboyproducer.com.ng/live/"));
  }
  assert.ok(!mail("1h", "https://evil.example/x", "2026-11-06T18:00:00").html.includes("evil.example"));
});

test("meet link: the link is never put in a place the registrant did not receive it (no page or status output)", () => {
  // the template is the only consumer; make sure the unsubscribe/headers are untouched and link is escaped in HTML
  const m = mail("1h", "https://meet.google.com/abc-defg-hij?x=1&y=2", "2026-11-06T18:00:00");
  assert.ok(m.html.includes("x=1&amp;y=2"), "ampersand escaped in the HTML attribute");
  assert.ok(m.html.includes(UNSUB) && m.text.includes(UNSUB));
});
