"use strict";

// West Africa Time is UTC+1 all year (no daylight saving), so a fixed offset is exact.
const WAT_OFFSET_MIN = 60;

function list(value, fallback) {
  return String(value || fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Read fresh on every call (not cached at load) so env changes on the host take effect
// after a restart without any code path holding a stale copy.
function liveConfig(env = process.env) {
  return {
    eventName: env.LIVE_EVENT_NAME || "How To Stop Wasting Money Promoting Your Songs",
    weekday: num(env.LIVE_WEEKDAY, 5),        // 0 = Sunday ... 5 = Friday
    hourWat: num(env.LIVE_HOUR_WAT, 20),      // 8:00 PM WAT
    durationMin: num(env.LIVE_DURATION_MIN, 60),
    pageUrl: env.LIVE_PAGE_URL || "https://fineboyproducer.com.ng/live/",
    segmentName: env.LIVE_SEGMENT_NAME || "Live Registrants",
    allowedOrigins: list(env.LIVE_ALLOWED_ORIGINS, "https://fineboyproducer.com.ng,https://www.fineboyproducer.com.ng"),
    emailKinds: list(env.LIVE_EMAIL_KINDS, "confirm,24h,1h,live"),
    fromName: env.LIVE_FROM_NAME || env.FROM_NAME || "",
    cronSecret: env.CRON_SECRET || "",
    appUrl: (env.APP_URL || "").replace(/\/$/, ""),
    syncFromSiteTable: String(env.LIVE_SYNC_FROM_SITE_TABLE ?? "true").toLowerCase() !== "false",
  };
}

module.exports = { liveConfig, WAT_OFFSET_MIN };
