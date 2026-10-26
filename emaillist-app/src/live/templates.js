"use strict";

const { whenLabel } = require("./session");

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

const cleanName = (s) => String(s || "there").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 40) || "there";

const fmtUTC = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// Window rules (when each reminder may go out) live in reminders.js; this file is wording only.
// Wording avoids "in 1 hour" style claims that go stale if a run is a few minutes late.
const COPY = {
  confirm: (ctx) => ({
    subject: `You're in: ${ctx.eventName}`,
    headline: "You're in.",
    lead: "You're registered for the live session. Keep this email: it has the live page and a calendar button. We'll remind you before it starts.",
  }),
  "24h": (ctx) => ({
    subject: `Tomorrow at ${ctx.timeLabel}: ${ctx.eventName}`,
    headline: `Tomorrow at ${ctx.timeLabel}.`,
    lead: "A quick reminder that the live masterclass is tomorrow. The Google Meet link is posted on the live page.",
  }),
  "1h": (ctx) => ({
    subject: `Tonight at ${ctx.timeLabel}: ${ctx.eventName}`,
    headline: `Tonight at ${ctx.timeLabel}.`,
    lead: "The live starts soon. Open the live page and tap Join on Google Meet.",
  }),
  live: (ctx) => ({
    subject: `We're live now: ${ctx.eventName}`,
    headline: "We're live now.",
    lead: "The live has started. Open the live page and tap Join on Google Meet.",
  }),
};

function gcalUrl(session, cfg) {
  return "https://calendar.google.com/calendar/render?" + new URLSearchParams({
    action: "TEMPLATE",
    text: `${cfg.eventName} (Live on Google Meet)`,
    dates: `${fmtUTC(session.startMs)}/${fmtUTC(session.endMs)}`,
    details: `A free live masterclass with Fineboy Producer.\n\nThe Google Meet link is posted on the live page: ${cfg.pageUrl}`,
    location: cfg.pageUrl,
  }).toString();
}

// -> { subject, html, text }
function renderLiveEmail(kind, reg, session, cfg, unsubscribeUrl) {
  const when = whenLabel(session);
  const timeLabel = when.split(" at ")[1];
  const copy = COPY[kind]({ eventName: cfg.eventName, timeLabel });
  const name = cleanName(reg.first_name);
  const calendar = gcalUrl(session, cfg);

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
<tr><td style="padding:24px 0 8px;">${btn(cfg.pageUrl, "Open the live page", true)}${btn(calendar, "Add to calendar", false)}</td></tr>
<tr><td style="font:400 15px/1.6 Arial,Helvetica,sans-serif;color:#9b978e;padding-top:14px;">Strategy before streams.<br>Fineboy Producer</td></tr>
<tr><td style="font:400 12px/1.6 Arial,Helvetica,sans-serif;color:#77736b;padding-top:28px;">You're getting this because you registered for this live at fineboyproducer.com.ng. <a href="${esc(unsubscribeUrl)}" style="color:#9b978e;">Unsubscribe from live reminders</a></td></tr>
</table></td></tr></table></body></html>`;

  const text = `${copy.headline}\n\nHi ${name},\n\n${copy.lead}\n\n${cfg.eventName}\n${when}\nLive on Google Meet\n\nLive page: ${cfg.pageUrl}\nAdd to calendar: ${calendar}\n\nStrategy before streams.\nFineboy Producer\n\nYou're getting this because you registered for this live at fineboyproducer.com.ng.\nUnsubscribe from live reminders: ${unsubscribeUrl}\n`;

  return { subject: copy.subject, html, text };
}

module.exports = { renderLiveEmail, cleanName, esc };
