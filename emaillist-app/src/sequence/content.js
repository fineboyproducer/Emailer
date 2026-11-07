"use strict";

const fs = require("fs");
const path = require("path");

const HEADER = /^=== (\w+) \| (lead|long|buyer-blueprint|buyer-bundle) \| (day|hours) (\d+) ===$/;

// Reads src/sequence/emails.md into [{ id, track, unit, n, subject, preview, body }].
function parseSteps(src) {
  const steps = [];
  let cur = null;
  for (const line of String(src).split(/\r?\n/)) {
    const m = HEADER.exec(line.trim());
    if (m) {
      cur = { id: m[1], track: m[2], unit: m[3], n: Number(m[4]), lines: [] };
      steps.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return steps.map((s) => {
    const lines = s.lines;
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    const subject = /^Subject:\s*(.+)$/.exec(lines[i] || "");
    i++;
    const preview = /^Preview:\s*(.+)$/.exec(lines[i] || "");
    i++;
    if (!subject || !preview) throw new Error(`Email ${s.id}: needs a "Subject:" line then a "Preview:" line`);
    const body = lines.slice(i).join("\n").trim();
    if (!body) throw new Error(`Email ${s.id}: empty body`);
    return { id: s.id, track: s.track, unit: s.unit, n: s.n, subject: subject[1].trim(), preview: preview[1].trim(), body };
  });
}

let cache = null;
function loadSteps() {
  if (!cache) cache = parseSteps(fs.readFileSync(path.join(__dirname, "emails.md"), "utf8"));
  return cache;
}

module.exports = { parseSteps, loadSteps };
