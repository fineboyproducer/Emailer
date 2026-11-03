"use strict";

const { WAT_OFFSET_MIN } = require("./config");

const MIN = 60000;
const DAY = 24 * 60 * MIN;

// The live session for a given Friday (YYYY-MM-DD, as a WAT calendar date).
function sessionForDate(dateKey, cfg) {
  const [y, m, d] = String(dateKey).split("-").map(Number);
  const startMs = Date.UTC(y, m - 1, d, cfg.hourWat, 0, 0) - WAT_OFFSET_MIN * MIN;
  return { dateKey, startMs, endMs: startMs + cfg.durationMin * MIN };
}

// The session someone registering at `nowMs` is signing up for: the next one that has not
// finished yet. Mirrors the rule on the live page, but the SERVER decides it, so a visitor
// with a wrong clock can never register for a past Friday and silently get no reminders.
function nextSession(nowMs, cfg) {
  const wat = new Date(nowMs + WAT_OFFSET_MIN * MIN); // shifted so getUTC* reads as WAT wall-clock
  const daysAhead = (cfg.weekday - wat.getUTCDay() + 7) % 7;
  let dateMs = Date.UTC(wat.getUTCFullYear(), wat.getUTCMonth(), wat.getUTCDate() + daysAhead);
  let session = sessionForDate(new Date(dateMs).toISOString().slice(0, 10), cfg);
  if (nowMs >= session.endMs) {
    dateMs += 7 * DAY;
    session = sessionForDate(new Date(dateMs).toISOString().slice(0, 10), cfg);
  }
  return session;
}

// "Friday, October 30, 2026 at 8:00 PM WAT"
function whenLabel(session) {
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Lagos", weekday: "long", month: "long", day: "numeric", year: "numeric",
  }).format(new Date(session.startMs));
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Lagos", hour: "numeric", minute: "2-digit", hour12: true,
  }).format(new Date(session.startMs));
  return `${date} at ${time} WAT`;
}

module.exports = { sessionForDate, nextSession, whenLabel, MIN };
