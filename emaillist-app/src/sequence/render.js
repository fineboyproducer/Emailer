"use strict";

// Turns an email's plain-markdown body into a plain-looking HTML email and a text version.
// Supported: paragraphs, "- " bullets, "1. " lists, **bold**, *italic*, [text](https://link).

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const LINK_STYLE = "color:#8a6d1a;text-decoration:underline;";

function inlineHtml(raw) {
  let s = esc(raw);
  s = s.replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, (_m, text, url) => `<a href="${url}" style="${LINK_STYLE}">${text}</a>`);
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
  return s;
}

function inlineText(raw) {
  return String(raw)
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, "$1 ($2)")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1");
}

function blocks(body) {
  return body.split(/\n\s*\n/).map((b) => b.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()));
}

function render(step, { name }, unsubscribeUrl, opts = {}) {
  const first = String(name || "").trim().split(/\s+/)[0] || "there";
  const fill = (s) => s.split("{{name}}").join(first);
  const body = fill(step.body);

  const p = "margin:0 0 18px;font:400 16px/1.65 Arial,Helvetica,sans-serif;color:#1a1a1a;";
  const htmlParts = [];
  const textParts = [];
  for (const lines of blocks(body)) {
    if (!lines.length) continue;
    if (lines.every((l) => /^- /.test(l))) {
      htmlParts.push(`<ul style="margin:0 0 18px;padding-left:22px;font:400 16px/1.65 Arial,Helvetica,sans-serif;color:#1a1a1a;">${lines.map((l) => `<li style="margin:0 0 6px;">${inlineHtml(l.slice(2))}</li>`).join("")}</ul>`);
      textParts.push(lines.map((l) => `- ${inlineText(l.slice(2))}`).join("\n"));
    } else if (lines.every((l) => /^\d+\. /.test(l))) {
      htmlParts.push(`<ol style="margin:0 0 18px;padding-left:22px;font:400 16px/1.65 Arial,Helvetica,sans-serif;color:#1a1a1a;">${lines.map((l) => `<li style="margin:0 0 6px;">${inlineHtml(l.replace(/^\d+\. /, ""))}</li>`).join("")}</ol>`);
      textParts.push(lines.map((l) => inlineText(l)).join("\n"));
    } else {
      htmlParts.push(`<p style="${p}">${lines.map(inlineHtml).join("<br>")}</p>`);
      textParts.push(lines.map(inlineText).join("\n"));
    }
  }

  const reason = step.track.startsWith("buyer")
    ? "You're getting this because you bought from Fineboy Producer."
    : "You're getting this because you registered for a live masterclass at fineboyproducer.com.ng.";
  const subject = (opts.subjectPrefix || "") + fill(step.subject);
  const preview = fill(step.preview);

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#ffffff;">${esc(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;"><tr><td align="center" style="padding:28px 18px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;"><tr><td>
${htmlParts.join("\n")}
<p style="margin:34px 0 0;font:400 12px/1.6 Arial,Helvetica,sans-serif;color:#77736b;">${esc(reason)} <a href="${esc(unsubscribeUrl)}" style="color:#77736b;text-decoration:underline;">Unsubscribe</a></p>
</td></tr></table></td></tr></table></body></html>`;

  const text = `${textParts.join("\n\n")}\n\n--\n${reason}\nUnsubscribe: ${unsubscribeUrl}\n`;
  return { subject, html, text };
}

module.exports = { render, esc };
