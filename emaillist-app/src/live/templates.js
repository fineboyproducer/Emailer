"use strict";

const { whenLabel } = require("./session");

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

const cleanName = (s) => String(s || "there").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 40) || "there";

// Only a real Google Meet address is ever put in an email (anything else is ignored, never rendered).
const MEET_RE = /^https:\/\/meet\.google\.com\/[a-z0-9-]+(\?[^\s"'<>]*)?$/i;
const safeMeetUrl = (u) => (typeof u === "string" && MEET_RE.test(u.trim()) ? u.trim() : "");
const DAY_MS = 24 * 60 * 60 * 1000;

const fmtUTC = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// Window rules (when each reminder may go out) live in reminders.js; this file is wording only.
// Wording avoids "in 1 hour" style claims that go stale if a run is a few minutes late.
const COPY = {
  confirm: (ctx) => ({
    subject: `You're in: ${ctx.eventName}`,
    headline: "You're in.",
    lead: ctx.join
      ? "You're registered for the live session. Your Google Meet link is below. Save it, or tap Add to calendar so it is on your phone."
      : "You're registered for the live session. Tap Add to calendar so it is saved on your phone. Your Google Meet link comes in your reminder emails.",
  }),
  "24h": (ctx) => ({
    subject: `Tomorrow at ${ctx.timeLabel}: ${ctx.eventName}`,
    headline: `Tomorrow at ${ctx.timeLabel}.`,
    lead: ctx.join
      ? "A quick reminder that the live masterclass is tomorrow. Your Google Meet link is below. Tap Add to calendar so it is saved on your phone."
      : "A quick reminder that the live masterclass is tomorrow. We'll send your Google Meet link in the reminder emails before it starts.",
  }),
  "1h": (ctx) => ({
    subject: `Tonight at ${ctx.timeLabel}: ${ctx.eventName}`,
    headline: `Tonight at ${ctx.timeLabel}.`,
    lead: ctx.join
      ? "The live starts soon. Tap the button below to join on Google Meet."
      : "The live starts soon. Open the live page for the latest details.",
  }),
  live: (ctx) => ({
    subject: `We're live now: ${ctx.eventName}`,
    headline: "We're live now.",
    lead: ctx.join
      ? "The live has started. Tap the button below to join on Google Meet."
      : "The live has started. Open the live page for the latest details.",
  }),
};

function gcalUrl(session, cfg, meetUrl) {
  return "https://calendar.google.com/calendar/render?" + new URLSearchParams({
    action: "TEMPLATE",
    text: `${cfg.eventName} (Live on Google Meet)`,
    dates: `${fmtUTC(session.startMs)}/${fmtUTC(session.endMs)}`,
    details: meetUrl
      ? `A free live masterclass with Fineboy Producer.\n\nJoin on Google Meet: ${meetUrl}`
      : `A free live masterclass with Fineboy Producer.\n\nDetails: ${cfg.pageUrl}`,
    location: meetUrl || cfg.pageUrl,
  }).toString();
}

// -> { subject, html, text }
// opts.meetUrl: this Friday's Google Meet link (from the live_meet_links table), if one has been added.
// opts.nowMs: when the email is being sent. The Join button appears on every reminder and on a confirmation
// sent within a day of the live; an earlier confirmation carries the link only inside its calendar button.
function renderLiveEmail(kind, reg, session, cfg, unsubscribeUrl, opts = {}) {
  const meetUrl = safeMeetUrl(opts.meetUrl);
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const join = !!meetUrl && (kind !== "confirm" || session.startMs - nowMs <= DAY_MS);
  const when = whenLabel(session);
  const timeLabel = when.split(" at ")[1];
  const copy = COPY[kind]({ eventName: cfg.eventName, timeLabel, join });
  const name = cleanName(reg.first_name);
  const calendar = gcalUrl(session, cfg, meetUrl);

  const btn = (href, label, primary) =>
    `<a href="${esc(href)}" style="display:inline-block;padding:15px 26px;margin:0 10px 10px 0;border-radius:4px;font:700 14px Arial,Helvetica,sans-serif;letter-spacing:.08em;text-transform:uppercase;text-decoration:none;${primary ? "background:#e6b64b;color:#0a0a0a;border:1px solid #e6b64b;" : "background:transparent;color:#e6b64b;border:1px solid #e6b64b;"}">${esc(label)}</a>`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#050505;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#050505;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;">
<tr><td style="font:700 12px Arial,Helvetica,sans-serif;letter-spacing:.28em;text-transform:uppercase;color:#e6b64b;padding-bottom:18px;">Live Masterclass &middot; Fineboy Producer</td></tr>
<tr><td style="font:400 42px/1.05 Impact,'Arial Narrow',Arial,sans-serif;text-transform:uppercase;color:#e6b64b;padding-bottom:18px;">${esc(copy.headline)}</td></tr>
<tr><td style="font:400 17px/1.6 Arial,Helvetica,sans-serif;color:#f3f1ec;padding-bottom:6px;">Hi ${esc(name)},</td></tr>
<tr><td style="font:400 17px/1.6 Arial,Helvetica,sans-serif;color:#f3f1ec;padding-bottom:22px;">${esc(copy.lead)}</td></tr>
<tr><td style="border-top:1px solid #3a3323;border-bottom:1px solid #3a3323;padding:18px 0;font:400 16px/1.6 Arial,Helvetica,sans-serif;color:#f3f1ec;">
<strong style="color:#e6b64b;">${esc(cfg.eventName)}</strong><br>${esc(when)}<br>Live on Google Meet</td></tr>
<tr><td style="padding:24px 0 8px;">${join ? btn(meetUrl, "Join on Google Meet", true) + btn(calendar, "Add to calendar", false) : btn(calendar, "Add to calendar", true) + btn(cfg.pageUrl, "Open the live page", false)}</td></tr>
<tr><td style="font:400 15px/1.6 Arial,Helvetica,sans-serif;color:#9b978e;padding-top:14px;">Strategy before streams.<br>Fineboy Producer</td></tr>
<tr><td style="font:400 12px/1.6 Arial,Helvetica,sans-serif;color:#77736b;padding-top:28px;">You're getting this because you registered for this live at fineboyproducer.com.ng. <a href="${esc(unsubscribeUrl)}" style="color:#9b978e;">Unsubscribe from live reminders</a></td></tr>
</table></td></tr></table></body></html>`;

  const text = `${copy.headline}\n\nHi ${name},\n\n${copy.lead}\n\n${cfg.eventName}\n${when}\nLive on Google Meet\n\n${join ? `Join on Google Meet: ${meetUrl}\n` : ""}Add to calendar: ${calendar}\nLive page: ${cfg.pageUrl}\n\nStrategy before streams.\nFineboy Producer\n\nYou're getting this because you registered for this live at fineboyproducer.com.ng.\nUnsubscribe from live reminders: ${unsubscribeUrl}\n`;

  return { subject: copy.subject, html, text };
}

module.exports = { renderLiveEmail, cleanName, esc, safeMeetUrl };
