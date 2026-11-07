"use strict";

const crypto = require("crypto");
const { pool } = require("../db");

// Paystack signs every webhook with HMAC-SHA512 of the raw body, using your secret key.
function verifyPaystackSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature).trim().toLowerCase(), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Which of the three offers a successful payment was for, judged by the amount (in kobo). Anything else
// (the Release Checklist, beats, a different price) is ignored rather than guessed at.
function productForAmount(amountKobo, currency, cfg) {
  if (currency && String(currency).toUpperCase() !== "NGN") return null;
  for (const [product, kobo] of Object.entries(cfg.amounts)) if (Number(amountKobo) === kobo) return product;
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Records a purchase (once per person per product) and makes sure the buyer is on the contact list so the
// buyer emails have an unsubscribe link. Someone who has unsubscribed stays unsubscribed.
async function recordPurchase({ email, name, product, reference, amountKobo, source = "manual", purchasedAt }) {
  const clean = String(email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) return { ok: false, error: "invalid email" };
  if (!["blueprint", "bundle", "agi"].includes(product)) return { ok: false, error: "unknown product" };

  const existing = (await pool.query("SELECT id FROM contacts WHERE lower(email) = $1", [clean])).rows[0];
  if (!existing) {
    await pool.query(
      "INSERT INTO contacts (name, email, unsubscribe_token) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [String(name || "").trim().slice(0, 120) || null, clean, crypto.randomBytes(24).toString("hex")]
    );
  }
  const { rows } = await pool.query(
    `INSERT INTO sequence_purchases (email, product, reference, amount_kobo, source, purchased_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [clean, product, reference || null, amountKobo || null, source, purchasedAt || null]
  );
  return { ok: true, created: rows.length > 0 };
}

// Turns a verified Paystack event body into a recorded purchase (or a reason it was ignored).
async function handlePaystackEvent(event, cfg) {
  if (!event || event.event !== "charge.success") return { ignored: "not a successful charge" };
  const d = event.data || {};
  if (d.status && d.status !== "success") return { ignored: "payment not successful" };
  const product = productForAmount(d.amount, d.currency, cfg);
  if (!product) return { ignored: "amount does not match an offer" };
  const customer = d.customer || {};
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(" ");
  const result = await recordPurchase({
    email: customer.email, name, product,
    reference: d.reference ? String(d.reference).slice(0, 100) : null,
    amountKobo: Number(d.amount), source: "paystack",
  });
  return result.ok ? { recorded: product, created: result.created } : { ignored: result.error };
}

module.exports = { verifyPaystackSignature, productForAmount, recordPurchase, handlePaystackEvent };
