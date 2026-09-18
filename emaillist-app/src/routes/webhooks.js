const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db");

const router = express.Router();

// Resend delivers webhooks through Svix, signed with three headers:
// svix-id, svix-timestamp, svix-signature. This verifies that signature by
// hand (HMAC-SHA256, per Svix's documented scheme) rather than pulling in
// the `svix` package, which is a large dependency whose only piece this
// app needs is this one check.
// Reference: https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests
function verifySignature(rawBody, headers, secret) {
  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const signatureHeader = headers["svix-signature"];
  if (!id || !timestamp || !signatureHeader) return false;

  // Reject requests outside a 5 minute window (Resend's documented replay
  // tolerance), so an intercepted request can't be replayed indefinitely.
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(Number(timestamp)) || Math.abs(now - Number(timestamp)) > 300) return false;

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");
  const expectedBuf = Buffer.from(expected);

  // svix-signature can carry multiple space-separated "v1,<sig>" values
  // (e.g. during secret rotation) - any one matching is valid.
  return signatureHeader.split(" ").some((part) => {
    const sig = part.startsWith("v1,") ? part.slice(3) : part;
    let sigBuf;
    try {
      sigBuf = Buffer.from(sig, "base64");
    } catch {
      return false;
    }
    if (sigBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
}

// Maps a Resend event type ("email.opened") to our event_type column value
// ("opened"). Anything outside our known set is logged and ignored, rather
// than rejected — new Resend event types shouldn't break this endpoint.
const KNOWN_EVENT_TYPES = new Set([
  "sent", "delivered", "delivery_delayed", "bounced",
  "complained", "opened", "clicked", "failed",
]);

function toEventType(resendType) {
  const short = String(resendType || "").replace(/^email\./, "");
  return KNOWN_EVENT_TYPES.has(short) ? short : null;
}

// The column on campaign_recipients that a given event type keeps in sync,
// for fast reads without joining email_events every time.
const SUMMARY_COLUMN = {
  delivered: "delivered_at",
  opened: "opened_at",
  clicked: "clicked_at",
  bounced: "bounced_at",
  complained: "complained_at",
  delivery_delayed: "delayed_at",
};

// POST /api/webhooks/resend
//
// IMPORTANT: this route is mounted with express.raw() ahead of the app's
// normal express.json() middleware (see server.js) — signature
// verification requires the exact raw bytes Resend signed, and re-parsing
// then re-stringifying JSON does not reliably reproduce them.
router.post("/resend", async (req, res) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[webhook] RESEND_WEBHOOK_SECRET is not set - rejecting incoming webhook.");
    return res.status(500).send("Webhook not configured.");
  }

  if (!Buffer.isBuffer(req.body)) {
    // Misconfigured middleware order would land here - fail loudly rather
    // than silently accepting an unverified payload.
    console.error("[webhook] Expected raw request body but got something else - check server.js middleware order.");
    return res.status(500).send("Server misconfiguration.");
  }

  const rawBody = req.body.toString("utf8");

  if (!verifySignature(rawBody, req.headers, secret)) {
    console.error("[webhook] Signature verification failed - rejecting request.");
    return res.status(400).send("Invalid signature.");
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).send("Invalid JSON.");
  }

  const svixId = req.headers["svix-id"]; // stable across Resend's redelivery attempts of the same event - our idempotency key
  const eventType = toEventType(event.type);
  const data = event.data || {};
  const messageId = data.email_id || null;
  const occurredAt = event.created_at || data.created_at || new Date().toISOString();

  if (!eventType) {
    console.log(`[webhook] Ignoring unrecognized event type: ${event.type}`);
    return res.status(200).json({ received: true, ignored: true });
  }
  if (!messageId) {
    console.log(`[webhook] Event ${event.type} had no email_id - nothing to attach it to, ignoring.`);
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    const recipientResult = await pool.query(
      "SELECT id, campaign_id, contact_id FROM campaign_recipients WHERE provider_message_id = $1",
      [messageId]
    );
    const recipient = recipientResult.rows[0] || null;
    // No matching recipient (e.g. this message id was a test send, or
    // predates this upgrade) - still record the event for visibility, just
    // without a campaign/contact/recipient association.

    const linkUrl = eventType === "clicked" && data.click ? data.click.link : null;
    const metadata = {};
    if (data.bounce) metadata.bounce = data.bounce;
    if (data.failed) metadata.failed = data.failed;
    if (data.click) metadata.click = { ipAddress: data.click.ipAddress, userAgent: data.click.userAgent };

    const insertResult = await pool.query(
      `INSERT INTO email_events
         (campaign_id, contact_id, campaign_recipient_id, provider_message_id, event_type, provider_event_id, link_url, metadata, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        recipient ? recipient.campaign_id : null,
        recipient ? recipient.contact_id : null,
        recipient ? recipient.id : null,
        messageId,
        eventType,
        svixId,
        linkUrl,
        JSON.stringify(metadata),
        occurredAt,
      ]
    );

    const isNewEvent = insertResult.rows.length > 0;

    if (isNewEvent && recipient) {
      const column = SUMMARY_COLUMN[eventType];
      if (column) {
        await pool.query(
          `UPDATE campaign_recipients SET status = $1, ${column} = COALESCE(${column}, $2) WHERE id = $3`,
          [eventType, occurredAt, recipient.id]
        );
      }
    }

    console.log(`[webhook] ${event.type} for message ${messageId} — ${isNewEvent ? "stored" : "duplicate, skipped"}${recipient ? ` (campaign ${recipient.campaign_id})` : " (no matching recipient)"}`);
    res.status(200).json({ received: true, stored: isNewEvent });
  } catch (err) {
    console.error("[webhook] Failed to process event:", err.message);
    // 500 so Resend retries this delivery - our unique index makes a
    // retry safe even if part of this handler already ran.
    res.status(500).json({ error: "Failed to process event." });
  }
});

module.exports = router;
