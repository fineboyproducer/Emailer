"use strict";

const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db");
const { liveConfig } = require("../live/config");
const { cleanRegistration, registerLive } = require("../live/register");
const { runReminders, sendConfirmationNow } = require("../live/reminders");
const { esc } = require("../live/templates");

// Public endpoints for the live registration page and the reminder scheduler.
// Mounted at /api/public/live (see server.js). None of these need the admin login.
const router = express.Router();

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// The live page is on a different domain, so the browser needs explicit permission to call this.
router.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = liveConfig().allowedOrigins;
  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// The page sends JSON as text/plain so the browser skips the CORS preflight round trip
// (which matters when this server is asleep and slow to wake). Parse both.
router.use(express.json({ type: ["application/json", "text/plain"], limit: "10kb" }));

// Lets the page wake a sleeping server before the visitor finishes the form.
router.get("/health", (req, res) => res.json({ ok: true }));

const registerLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,                       // generous: many phones in Nigeria share one carrier IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many attempts. Please try again in a few minutes." },
});

// POST /api/public/live/register  { first_name, email, whatsapp, artist_name, company_website }
router.post("/register", registerLimiter, async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};

  // Spam trap: real people never fill this. Bots get a quiet fake success.
  if (body.company_website) return res.json({ ok: true });

  const clean = cleanRegistration(body);
  if (!clean.ok) return res.status(400).json({ ok: false, error: clean.error });

  try {
    const result = await registerLive(clean.value, { source: "page" });
    res.json({ ok: true, created: result.created });
    // After the response, so the visitor never waits on email.
    if (result.created) setImmediate(() => sendConfirmationNow(result.registrationId));
  } catch (err) {
    console.error("[live] register failed:", err.message);
    res.status(500).json({ ok: false, error: "Could not save your registration." });
  }
});

// POST /api/public/live/cron   header: x-cron-secret   (optional ?dry_run=1)
// Called every 5 minutes by the scheduler (see .github/workflows/live-reminders.yml).
router.post("/cron", async (req, res) => {
  const secret = liveConfig().cronSecret;
  if (!secret) return res.status(500).json({ ok: false, error: "CRON_SECRET is not set on the server." });
  if (!safeEqual(req.get("x-cron-secret") || "", secret)) return res.status(401).json({ ok: false, error: "unauthorized" });

  try {
    const dryRun = req.query.dry_run === "1" || req.query.dry_run === "true";
    const summary = await runReminders({ dryRun });
    res.status(summary.ok ? 200 : 500).json(summary);
  } catch (err) {
    console.error("[live] cron run failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Unsubscribe from live reminders ----
// GET only shows a confirm button: email security scanners open every link in a message,
// so a plain visit must never unsubscribe anyone. The button (and mail apps' one-click
// "List-Unsubscribe" button) POST to the same URL, and that does it.
function page(heading, message, button) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Live reminders | Fineboy Producer</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px 24px;background:#050505;color:#f3f1ec;font:400 17px/1.6 -apple-system,'Segoe UI',Roboto,Arial,sans-serif}
main{width:min(520px,100%)}.brand{font-size:12px;font-weight:700;letter-spacing:.3em;text-transform:uppercase;color:#e6b64b}
h1{margin:20px 0 0;font:400 44px/1 Impact,'Arial Narrow',Arial,sans-serif;text-transform:uppercase;color:#f3f1ec}
.rule{width:100px;height:1px;background:#e6b64b;margin:24px 0}p{color:#9b978e;max-width:44ch;margin:0}
button{margin-top:28px;min-height:52px;padding:0 28px;background:#e6b64b;color:#0a0a0a;border:0;border-radius:4px;font:700 14px Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}
a{color:#e6b64b;display:inline-block;margin-top:28px}
</style></head><body><main><p class="brand">Fineboy Producer</p><h1>${esc(heading)}</h1><div class="rule"></div><p>${esc(message)}</p>${button || ""}<br><a href="${esc(liveConfig().pageUrl)}">Back to the live page</a></main></body></html>`;
}

async function findContactByToken(token) {
  if (!token || String(token).length > 200) return null;
  const { rows } = await pool.query("SELECT id FROM contacts WHERE unsubscribe_token = $1", [String(token)]);
  return rows[0] || null;
}

router.get("/unsubscribe", async (req, res) => {
  try {
    const contact = await findContactByToken(req.query.token);
    if (!contact) {
      return res.status(404).type("html").send(page("This link isn't valid.", "Open the unsubscribe link in your email again. If it still doesn't work, message @fineboyproducer_ on Instagram and we'll remove you."));
    }
    res.type("html").send(page(
      "Stop the reminders?",
      "You'll stop getting email reminders for the live masterclass.",
      `<form method="post" action="?token=${encodeURIComponent(String(req.query.token))}"><button type="submit">Unsubscribe</button></form>`
    ));
  } catch (err) {
    console.error("[live] unsubscribe check failed:", err.message);
    res.status(500).type("html").send(page("Something went wrong.", "Please try again in a moment."));
  }
});

router.post("/unsubscribe", async (req, res) => {
  const token = req.query.token || (req.body && req.body.token);
  try {
    const contact = await findContactByToken(token);
    if (!contact) {
      return res.status(404).type("html").send(page("This link isn't valid.", "Open the unsubscribe link in your email again."));
    }
    await pool.query(
      "UPDATE live_registrations SET unsubscribed_at = COALESCE(unsubscribed_at, now()) WHERE contact_id = $1",
      [contact.id]
    );
    // Mail apps' one-click button posts "List-Unsubscribe=One-Click" and ignores the body;
    // people pressing our button get the friendly page.
    if (req.body && req.body["List-Unsubscribe"]) return res.status(200).send("Unsubscribed.");
    res.type("html").send(page("You're unsubscribed.", "You won't get any more reminders for the live masterclass."));
  } catch (err) {
    console.error("[live] unsubscribe failed:", err.message);
    res.status(500).type("html").send(page("Something went wrong.", "Please try again in a moment."));
  }
});

module.exports = router;
