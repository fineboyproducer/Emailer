require("dotenv").config();
const path = require("path");
const express = require("express");
const session = require("express-session");

const { pool } = require("./src/db");
const authRoutes = require("./src/routes/auth");
const contactsRoutes = require("./src/routes/contacts");
const campaignsRoutes = require("./src/routes/campaigns");
const segmentsRoutes = require("./src/routes/segments");
const settingsRoutes = require("./src/routes/settings");
const webhooksRoutes = require("./src/routes/webhooks");
const { requireLogin } = require("./src/middleware/auth");
const { configStatus } = require("./src/emailProvider");

const app = express();
const PORT = process.env.PORT || 3000;

// Most hosting platforms (Render, Railway, Heroku, etc) put the app behind
// a reverse proxy. Without this, Express can't tell the request arrived
// over HTTPS, which silently breaks `cookie.secure` below (the login
// session cookie would never get set in production) and can also make
// express-rate-limit throw on the X-Forwarded-For header it receives.
app.set("trust proxy", 1);

if (!process.env.SESSION_SECRET) {
  console.warn("WARNING: SESSION_SECRET is not set in .env - using an insecure default. Set this before deploying.");
}

// Diagnostic: report (masked) email + database config at boot, so a
// misconfigured deployment shows up immediately in the platform's server
// logs instead of only failing silently later.
const emailConfig = configStatus();
if (!emailConfig.hasApiKey) {
  console.warn("WARNING: RESEND_API_KEY is not set in this environment - test/campaign emails will fail until it's added in your hosting provider's dashboard.");
} else if (!emailConfig.fromEmail) {
  console.warn("WARNING: FROM_EMAIL is not set in this environment - test/campaign emails will fail until it's added.");
} else {
  console.log(`Email sending configured — key: ${emailConfig.apiKeyMasked}, from: ${emailConfig.fromName ? `${emailConfig.fromName} <${emailConfig.fromEmail}>` : emailConfig.fromEmail}`);
}
if (!process.env.RESEND_WEBHOOK_SECRET) {
  console.warn("WARNING: RESEND_WEBHOOK_SECRET is not set - incoming Resend webhooks (opens/clicks/bounces/etc) will be rejected until it's added.");
}
pool.query("SELECT 1")
  .then(() => console.log("Database: connected to Supabase Postgres."))
  .catch((err) => console.error("WARNING: could not connect to the database at startup:", err.message));

// The Resend webhook needs the RAW request body to verify its signature -
// mounted here, before the global express.json() below, with its own
// express.raw() so this one path never gets JSON-parsed first (which would
// change the exact bytes the signature was computed over and break
// verification). Every other route still gets normal JSON parsing.
app.use("/api/webhooks", express.raw({ type: "application/json" }), webhooksRoutes);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "insecure-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      secure: process.env.NODE_ENV === "production",
    },
  })
);

// Public: one-click unsubscribe (must not require login - the recipient
// isn't logged in). If the link carries a `campaign` id (every real
// campaign send includes one; test emails don't), the unsubscribe is also
// recorded as an email_event attached to that campaign's analytics.
app.get("/unsubscribe", async (req, res) => {
  const { token, campaign } = req.query;
  if (!token) return res.status(400).send("Missing unsubscribe link.");

  const { rows } = await pool.query("SELECT id, email FROM contacts WHERE unsubscribe_token = $1", [token]);
  const contact = rows[0];
  if (!contact) {
    return res.status(404).send("<p style='font-family:sans-serif'>This unsubscribe link is invalid or expired.</p>");
  }

  await pool.query("UPDATE contacts SET status = 'unsubscribed' WHERE id = $1", [contact.id]);

  const campaignId = Number(campaign);
  if (Number.isInteger(campaignId) && campaignId > 0) {
    const recipientResult = await pool.query(
      "SELECT id FROM campaign_recipients WHERE campaign_id = $1 AND contact_id = $2",
      [campaignId, contact.id]
    );
    const recipient = recipientResult.rows[0];
    if (recipient) {
      await pool.query(
        `UPDATE campaign_recipients SET unsubscribed_at = COALESCE(unsubscribed_at, now()) WHERE id = $1`,
        [recipient.id]
      );
      // Idempotent even without a provider_event_id: a repeat click (or a
      // mail client prefetching the link) just won't insert a second row.
      await pool.query(
        `INSERT INTO email_events (campaign_id, contact_id, campaign_recipient_id, event_type)
         SELECT $1, $2, $3, 'unsubscribed'
         WHERE NOT EXISTS (
           SELECT 1 FROM email_events
           WHERE campaign_recipient_id = $3 AND event_type = 'unsubscribed'
         )`,
        [campaignId, contact.id, recipient.id]
      );
    }
  }

  res.send(`
    <html><body style="font-family:-apple-system,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#111;">
      <h2>You're unsubscribed</h2>
      <p style="color:#555;">${contact.email} won't receive any more emails from this list.</p>
    </body></html>
  `);
});

app.use("/api/auth", authRoutes);
app.use("/api/contacts", contactsRoutes);
app.use("/api/campaigns", campaignsRoutes);
app.use("/api/segments", segmentsRoutes);
app.use("/api/settings", settingsRoutes);

// Protect all HTML pages except login.html itself and static assets.
app.use((req, res, next) => {
  const openPaths = ["/login.html", "/unsubscribe"];
  const isAsset = req.path.startsWith("/css/") || req.path.startsWith("/js/");
  if (openPaths.includes(req.path) || isAsset || req.path.startsWith("/api/")) {
    return next();
  }
  return requireLogin(req, res, next);
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Email list app running at http://localhost:${PORT}`);
});
