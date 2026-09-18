const express = require("express");
const rateLimit = require("express-rate-limit");
const { pool, withTransaction } = require("../db");
const { requireLogin } = require("../middleware/auth");
const { sendEmail, configStatus } = require("../emailProvider");

const router = express.Router();

const sendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15, // at most 15 send/test actions per 10 minutes - this is a personal tool, not a bulk sender
  message: { error: "You're sending too fast. Wait a few minutes and try again." },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function personalize(html, contact) {
  const safeName = (contact && contact.name && contact.name.trim()) || "there";
  return html
    .split("{{name}}").join(safeName)
    .split("{{email}}").join((contact && contact.email) || "");
}

// The unsubscribe link carries which campaign prompted it (when there is
// one - test emails have none), so an unsubscribe can be attributed back
// to that campaign's analytics, not just to the contact.
function unsubscribeFooter(token, campaignId) {
  const url = new URL(`${process.env.APP_URL || ""}/unsubscribe`);
  url.searchParams.set("token", token);
  if (campaignId) url.searchParams.set("campaign", campaignId);
  return `<p style="margin-top:32px;font-size:12px;color:#888;">You're receiving this because you're on this list.
  <a href="${url.toString()}" style="color:#888;">Unsubscribe</a></p>`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSegmentIds(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

// Resolve a recipient set for either "all active contacts" or a set of
// segments. Segment mode de-duplicates: a contact in multiple selected
// segments is only ever included once (DISTINCT ON contact id via GROUP BY).
// Unsubscribed contacts are always excluded, in both modes.
async function resolveRecipients(mode, segmentIds) {
  if (mode === "segments" && segmentIds.length) {
    const { rows: recipients } = await pool.query(`
      SELECT DISTINCT c.id, c.name, c.email, c.unsubscribe_token
      FROM contacts c
      JOIN contact_segments cs ON cs.contact_id = c.id
      WHERE cs.segment_id = ANY($1::bigint[]) AND c.status = 'active'
    `, [segmentIds]);

    const { rows: excludedRows } = await pool.query(`
      SELECT COUNT(DISTINCT c.id)::int AS count
      FROM contacts c
      JOIN contact_segments cs ON cs.contact_id = c.id
      WHERE cs.segment_id = ANY($1::bigint[]) AND c.status = 'unsubscribed'
    `, [segmentIds]);

    return { recipients, excludedUnsubscribed: excludedRows[0].count };
  }

  const { rows: recipients } = await pool.query(
    "SELECT id, name, email, unsubscribe_token FROM contacts WHERE status = 'active'"
  );
  const { rows: excludedRows } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM contacts WHERE status = 'unsubscribed'"
  );
  return { recipients, excludedUnsubscribed: excludedRows[0].count };
}

// Turns a "today" | "7d" | "30d" | "all" range into a lower timestamp bound.
function rangeSince(range) {
  const now = new Date();
  switch (range) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start;
    }
    case "7d":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "30d":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    default:
      return null; // "all"
  }
}

function rate(numerator, denominator) {
  if (!denominator) return null;
  return numerator / denominator;
}

// GET /api/campaigns/dashboard?range=today|7d|30d|all - homepage stats
router.get("/dashboard", requireLogin, async (req, res) => {
  const range = ["today", "7d", "30d"].includes(req.query.range) ? req.query.range : "all";
  const since = rangeSince(range);

  const totalContacts = (await pool.query("SELECT COUNT(*)::int AS n FROM contacts")).rows[0].n;
  const active = (await pool.query("SELECT COUNT(*)::int AS n FROM contacts WHERE status = 'active'")).rows[0].n;
  const unsubscribed = (await pool.query("SELECT COUNT(*)::int AS n FROM contacts WHERE status = 'unsubscribed'")).rows[0].n;
  const campaignsSent = (await pool.query(
    "SELECT COUNT(*)::int AS n FROM campaigns WHERE sent_at >= COALESCE($1::timestamptz, '-infinity'::timestamptz)",
    [since]
  )).rows[0].n;

  const segments = (await pool.query(`
    SELECT s.id, s.name, COUNT(cs.contact_id)::int AS contact_count
    FROM segments s
    LEFT JOIN contact_segments cs ON cs.segment_id = s.id
    GROUP BY s.id
    ORDER BY contact_count DESC, s.name
  `)).rows;

  const recentCampaigns = (await pool.query(
    "SELECT id, subject, recipient_count, failed_count, status, sent_at FROM campaigns ORDER BY sent_at DESC LIMIT 5"
  )).rows;

  // Email performance, aggregated across every campaign in range.
  const perf = (await pool.query(`
    WITH rc AS (
      SELECT id FROM campaigns WHERE sent_at >= COALESCE($1::timestamptz, '-infinity'::timestamptz)
    ),
    recipients AS (
      SELECT * FROM campaign_recipients WHERE campaign_id IN (SELECT id FROM rc)
    ),
    events AS (
      SELECT * FROM email_events WHERE campaign_id IN (SELECT id FROM rc)
    )
    SELECT
      (SELECT COUNT(*) FROM recipients WHERE provider_message_id IS NOT NULL)::int AS emails_sent,
      (SELECT COUNT(DISTINCT campaign_recipient_id) FROM events WHERE event_type = 'delivered')::int AS delivered,
      (SELECT COUNT(DISTINCT campaign_recipient_id) FROM events WHERE event_type = 'opened')::int AS opened_unique,
      (SELECT COUNT(DISTINCT campaign_recipient_id) FROM events WHERE event_type = 'clicked')::int AS clicked_unique,
      (SELECT COUNT(DISTINCT campaign_recipient_id) FROM events WHERE event_type = 'unsubscribed')::int AS unsubscribed_from_campaigns,
      (SELECT COUNT(DISTINCT campaign_recipient_id) FROM events WHERE event_type = 'complained')::int AS complained
  `, [since])).rows[0];

  res.json({
    range,
    totalContacts, active, unsubscribed, campaignsSent, segments, recentCampaigns,
    performance: {
      emailsSent: perf.emails_sent,
      deliveryRate: rate(perf.delivered, perf.emails_sent),
      openRate: rate(perf.opened_unique, perf.delivered),
      clickRate: rate(perf.clicked_unique, perf.delivered),
      unsubscribeRate: rate(perf.unsubscribed_from_campaigns, perf.delivered),
      complaintRate: rate(perf.complained, perf.delivered),
    },
  });
});

// GET /api/campaigns/recipients-count?mode=all|segments&segmentIds=1,2,3
router.get("/recipients-count", requireLogin, async (req, res) => {
  const mode = req.query.mode === "segments" ? "segments" : "all";
  const segmentIds = parseSegmentIds(req.query.segmentIds);
  const { recipients, excludedUnsubscribed } = await resolveRecipients(mode, segmentIds);
  res.json({ count: recipients.length, excludedUnsubscribed });
});

// GET /api/campaigns - campaign list, with per-campaign delivery/engagement summary
router.get("/", requireLogin, async (req, res) => {
  const { rows: campaigns } = await pool.query(`
    SELECT
      c.id, c.subject, c.sender_name, c.recipient_count, c.failed_count,
      c.status, c.sent_at, c.recipient_mode, c.excluded_unsubscribed,
      (SELECT STRING_AGG(segment_name, ', ' ORDER BY segment_name) FROM campaign_segments WHERE campaign_id = c.id) AS segment_names,
      (SELECT COUNT(*) FROM campaign_recipients cr WHERE cr.campaign_id = c.id AND cr.provider_message_id IS NOT NULL)::int AS sent,
      (SELECT COUNT(DISTINCT ee.campaign_recipient_id) FROM email_events ee WHERE ee.campaign_id = c.id AND ee.event_type = 'delivered')::int AS delivered,
      (SELECT COUNT(DISTINCT ee.campaign_recipient_id) FROM email_events ee WHERE ee.campaign_id = c.id AND ee.event_type = 'opened')::int AS opened_unique,
      (SELECT COUNT(DISTINCT ee.campaign_recipient_id) FROM email_events ee WHERE ee.campaign_id = c.id AND ee.event_type = 'clicked')::int AS clicked_unique,
      (SELECT COUNT(DISTINCT ee.campaign_recipient_id) FROM email_events ee WHERE ee.campaign_id = c.id AND ee.event_type = 'unsubscribed')::int AS unsubscribed
    FROM campaigns c
    ORDER BY c.sent_at DESC
  `);

  const withRates = campaigns.map((c) => ({
    ...c,
    delivery_rate: rate(c.delivered, c.sent),
    open_rate: rate(c.opened_unique, c.delivered),
    click_rate: rate(c.clicked_unique, c.delivered),
  }));

  res.json({ campaigns: withRates });
});

// GET /api/campaigns/:id - basic campaign record (subject/body/segments) -
// used for the "Duplicate Campaign" prefill flow. For the full analytics
// report, see GET /:id/report below.
router.get("/:id", requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, subject, sender_name, body_html, recipient_count, failed_count, status, sent_at, recipient_mode, excluded_unsubscribed FROM campaigns WHERE id = $1",
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Campaign not found." });

  const { rows: segments } = await pool.query(
    "SELECT segment_id AS id, segment_name AS name FROM campaign_segments WHERE campaign_id = $1",
    [req.params.id]
  );

  res.json({ campaign: { ...rows[0], segments } });
});

// GET /api/campaigns/:id/report - the full delivery/engagement/list-health report
router.get("/:id/report", requireLogin, async (req, res) => {
  const campaignResult = await pool.query(
    "SELECT id, subject, sender_name, sent_at, status, recipient_mode FROM campaigns WHERE id = $1",
    [req.params.id]
  );
  if (!campaignResult.rows.length) return res.status(404).json({ error: "Campaign not found." });
  const campaign = campaignResult.rows[0];

  const segments = (await pool.query(
    "SELECT segment_id AS id, segment_name AS name FROM campaign_segments WHERE campaign_id = $1",
    [req.params.id]
  )).rows;

  const counts = (await pool.query(`
    WITH r AS (SELECT * FROM campaign_recipients WHERE campaign_id = $1),
         e AS (SELECT * FROM email_events WHERE campaign_id = $1)
    SELECT
      (SELECT COUNT(*) FROM r)::int AS recipients,
      (SELECT COUNT(*) FROM r WHERE provider_message_id IS NOT NULL)::int AS sent,
      (SELECT COUNT(*) FROM r WHERE status = 'failed')::int AS failed,
      (SELECT COUNT(DISTINCT campaign_recipient_id) FROM e WHERE event_type = 'delivered')::int AS delivered,
      (SELECT COUNT(DISTINCT campaign_recipient_id) FROM e WHERE event_type = 'delivery_delayed')::int AS delayed,
      (SELECT COUNT(DISTINCT campaign_recipient_id) FROM e WHERE event_type = 'bounced')::int AS bounced,
      (SELECT COUNT(*) FROM e WHERE event_type = 'opened')::int AS opens_total,
      (SELECT COUNT(DISTINCT campaign_recipient_id) FROM e WHERE event_type = 'opened')::int AS opens_unique,
      (SELECT COUNT(*) FROM e WHERE event_type = 'clicked')::int AS clicks_total,
      (SELECT COUNT(DISTINCT campaign_recipient_id) FROM e WHERE event_type = 'clicked')::int AS clicks_unique,
      (SELECT COUNT(DISTINCT campaign_recipient_id) FROM e WHERE event_type = 'unsubscribed')::int AS unsubscribed,
      (SELECT COUNT(DISTINCT campaign_recipient_id) FROM e WHERE event_type = 'complained')::int AS complained
  `, [req.params.id])).rows[0];

  const topLinks = (await pool.query(`
    SELECT link_url,
           COUNT(*)::int AS total_clicks,
           COUNT(DISTINCT campaign_recipient_id)::int AS unique_clicks
    FROM email_events
    WHERE campaign_id = $1 AND event_type = 'clicked' AND link_url IS NOT NULL
    GROUP BY link_url
    ORDER BY total_clicks DESC
    LIMIT 10
  `, [req.params.id])).rows;

  res.json({
    campaign: { ...campaign, segments },
    counts,
    rates: {
      deliveryRate: rate(counts.delivered, counts.sent),
      bounceRate: rate(counts.bounced, counts.sent),
      openRate: rate(counts.opens_unique, counts.delivered),
      clickRate: rate(counts.clicks_unique, counts.delivered),
      clickToOpenRate: rate(counts.clicks_unique, counts.opens_unique),
      unsubscribeRate: rate(counts.unsubscribed, counts.delivered),
      complaintRate: rate(counts.complained, counts.delivered),
    },
    topLinks,
  });
});

// POST /api/campaigns/send-test  { subject, bodyHtml, senderName, testEmail }
router.post("/send-test", requireLogin, sendLimiter, async (req, res) => {
  const { subject, bodyHtml, senderName, testEmail } = req.body;
  if (!subject || !bodyHtml || !testEmail || !EMAIL_RE.test(testEmail)) {
    return res.status(400).json({ error: "Subject, email body, and a valid test email address are all required." });
  }

  const config = configStatus();
  if (!config.hasApiKey) {
    console.error("[campaigns] send-test blocked: RESEND_API_KEY missing.");
    return res.status(500).json({ error: "RESEND_API_KEY is not set on the server. Add it in your hosting provider's environment variables and redeploy.", code: "missing_api_key" });
  }
  if (!config.fromEmail) {
    console.error("[campaigns] send-test blocked: FROM_EMAIL missing.");
    return res.status(500).json({ error: "FROM_EMAIL is not set on the server.", code: "missing_from_email" });
  }

  console.log(`[campaigns] send-test requested → to: ${testEmail}, subject: "${subject}"`);

  // Test emails have no campaign/recipient row to attach an unsubscribe
  // event to - "test" is a placeholder token, not a real contact's.
  const html = personalize(bodyHtml, { name: "there", email: testEmail }) + unsubscribeFooter("test", null);
  const result = await sendEmail({
    to: testEmail,
    subject: `[TEST] ${subject}`,
    html,
    fromEmail: process.env.FROM_EMAIL,
    fromName: senderName || process.env.FROM_NAME,
  });

  if (!result.ok) {
    console.error(`[campaigns] send-test failed (${result.code}): ${result.error}`);
    return res.status(502).json({ error: `Resend error: ${result.error}`, code: result.code });
  }
  console.log(`[campaigns] send-test accepted by Resend — id: ${result.id}`);
  res.json({ ok: true, id: result.id });
});

// POST /api/campaigns/send  { subject, bodyHtml, senderName, mode: 'all'|'segments', segmentIds: [1,2] }
router.post("/send", requireLogin, sendLimiter, async (req, res) => {
  const { subject, bodyHtml, senderName } = req.body;
  const mode = req.body.mode === "segments" ? "segments" : "all";
  const segmentIds = Array.isArray(req.body.segmentIds) ? req.body.segmentIds.map(Number).filter(Boolean) : [];

  if (!subject || !bodyHtml) {
    return res.status(400).json({ error: "Subject and email body are required." });
  }
  if (mode === "segments" && !segmentIds.length) {
    return res.status(400).json({ error: "Select at least one segment, or choose \"All active contacts\"." });
  }

  const config = configStatus();
  if (!config.hasApiKey) {
    console.error("[campaigns] send blocked: RESEND_API_KEY missing.");
    return res.status(500).json({ error: "RESEND_API_KEY is not set on the server. Add it in your hosting provider's environment variables and redeploy.", code: "missing_api_key" });
  }
  if (!config.fromEmail) {
    console.error("[campaigns] send blocked: FROM_EMAIL missing.");
    return res.status(500).json({ error: "FROM_EMAIL is not set on the server.", code: "missing_from_email" });
  }

  const { recipients, excludedUnsubscribed } = await resolveRecipients(mode, segmentIds);
  if (!recipients.length) {
    return res.status(400).json({ error: "There are no active subscribers matching that selection." });
  }

  console.log(`[campaigns] send requested — mode: ${mode}, recipients: ${recipients.length}, subject: "${subject}"`);

  // 1. Create the campaign row (and its targeted-segments snapshot) up
  // front, so every recipient row below has a campaign_id to attach to —
  // and so a crash partway through sending still leaves a real campaign
  // record with whatever got sent before it.
  const fromEmail = process.env.FROM_EMAIL;
  const fromName = senderName || process.env.FROM_NAME;

  const campaignId = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO campaigns (subject, sender_name, body_html, recipient_count, failed_count, status, recipient_mode, excluded_unsubscribed)
       VALUES ($1, $2, $3, 0, 0, 'sent', $4, $5) RETURNING id`,
      [subject, fromName || "", bodyHtml, mode, excludedUnsubscribed]
    );
    const id = inserted.rows[0].id;

    if (mode === "segments") {
      const { rows: segRows } = await client.query(
        "SELECT id, name FROM segments WHERE id = ANY($1::bigint[])",
        [segmentIds]
      );
      for (const s of segRows) {
        await client.query(
          "INSERT INTO campaign_segments (campaign_id, segment_id, segment_name) VALUES ($1, $2, $3)",
          [id, s.id, s.name]
        );
      }
    }

    for (const contact of recipients) {
      await client.query(
        "INSERT INTO campaign_recipients (campaign_id, contact_id, email, status) VALUES ($1, $2, $3, 'pending')",
        [id, contact.id, contact.email]
      );
    }

    return id;
  });

  // 2. Send one at a time with a small delay, to stay well under free-tier
  // rate limits. Fine for personal-list volumes; not built for scale.
  let sent = 0, failed = 0;
  let firstFailureReason = null;

  for (const contact of recipients) {
    const html = personalize(bodyHtml, contact) + unsubscribeFooter(contact.unsubscribe_token, campaignId);
    const result = await sendEmail({
      to: contact.email,
      subject,
      html,
      fromEmail,
      fromName,
    });

    if (result.ok) {
      sent++;
      await pool.query(
        "UPDATE campaign_recipients SET status = 'sent', provider_message_id = $1, sent_at = now() WHERE campaign_id = $2 AND contact_id = $3",
        [result.id, campaignId, contact.id]
      );
      await pool.query(
        "INSERT INTO email_events (campaign_id, contact_id, campaign_recipient_id, provider_message_id, event_type) " +
        "SELECT $1, $2, id, $3, 'sent' FROM campaign_recipients WHERE campaign_id = $1 AND contact_id = $2",
        [campaignId, contact.id, result.id]
      );
    } else {
      failed++;
      if (!firstFailureReason) firstFailureReason = result.error;
      console.error(`[campaigns] send failed for ${contact.email} (${result.code}): ${result.error}`);
      await pool.query(
        "UPDATE campaign_recipients SET status = 'failed', error = $1 WHERE campaign_id = $2 AND contact_id = $3",
        [result.error, campaignId, contact.id]
      );
    }
    await sleep(550); // ~1.8 emails/sec, under most free-tier caps
  }

  console.log(`[campaigns] send finished — sent: ${sent}, failed: ${failed}`);

  const status = failed === 0 ? "sent" : sent === 0 ? "failed" : "partial";
  await pool.query(
    "UPDATE campaigns SET recipient_count = $1, failed_count = $2, status = $3 WHERE id = $4",
    [sent, failed, status, campaignId]
  );

  const response = { ok: true, sent, failed, campaignId };
  if (failed > 0) response.firstFailureReason = firstFailureReason;
  res.json(response);
});

module.exports = router;
