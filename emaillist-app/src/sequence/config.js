"use strict";

function num(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// "blueprint:35000,bundle:27750,agi:99700" (naira) -> { blueprint: 3500000, ... } (kobo)
function parseAmounts(raw) {
  const out = {};
  for (const part of String(raw || "blueprint:35000,bundle:27750,agi:99700").split(",")) {
    const [product, naira] = part.split(":").map((s) => s.trim());
    const n = Number(naira);
    if (["blueprint", "bundle", "agi"].includes(product) && Number.isFinite(n) && n > 0) out[product] = Math.round(n * 100);
  }
  return out;
}

// Read fresh on every call so an env change on the host takes effect after a restart.
function sequenceConfig(env = process.env) {
  return {
    enabled: ["1", "true", "yes"].includes(String(env.SEQ_ENABLED || "").toLowerCase()),
    sendHourWat: num(env.SEQ_SEND_HOUR_WAT, 8),         // lead emails go out from 8:00 AM WAT on their day
    leadLateHours: num(env.SEQ_LATE_HOURS, 30),         // how long after its time a lead email may still go out
    buyerLateHours: num(env.SEQ_BUYER_LATE_HOURS, 48),
    dailyCap: num(env.SEQ_DAILY_CAP, 80),               // total emails per WAT day, counting live reminders too
    maxPerRun: num(env.SEQ_MAX_PER_RUN, 40),
    onlyEmail: String(env.SEQ_ONLY_EMAIL || "").trim().toLowerCase(),   // rehearsal: send to this one address only
    testEmail: String(env.SEQ_TEST_EMAIL || "").trim().toLowerCase(),   // the only address /sequence/test may send to
    replyTo: String(env.SEQ_REPLY_TO || "").trim(),
    paystackSecret: String(env.PAYSTACK_SECRET_KEY || "").trim(),
    amounts: parseAmounts(env.SEQ_PRODUCT_AMOUNTS),
    fromName: env.LIVE_FROM_NAME || env.FROM_NAME || "",
    appUrl: (env.APP_URL || "").replace(/\/$/, ""),
  };
}

module.exports = { sequenceConfig, parseAmounts };
