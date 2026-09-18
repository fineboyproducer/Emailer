const express = require("express");
const { pool } = require("../db");
const { requireLogin } = require("../middleware/auth");

const router = express.Router();

async function getSegmentWithCount(id) {
  const { rows } = await pool.query(`
    SELECT s.id, s.name, s.description, s.created_at,
           COUNT(cs.contact_id)::int AS contact_count
    FROM segments s
    LEFT JOIN contact_segments cs ON cs.segment_id = s.id
    WHERE s.id = $1
    GROUP BY s.id
  `, [id]);
  return rows[0] || null;
}

// GET /api/segments - list all segments with contact counts and (lightweight)
// performance stats.
//
// "campaigns_sent" / "avg_open_rate" / "avg_click_rate" are computed from
// campaign_segments — i.e. campaigns that targeted this segment AT SEND
// TIME — not from who happens to be in the segment today. A segment's
// average open/click rate is the plain average of each of those campaigns'
// own open/click rate (each campaign counted once, regardless of size).
router.get("/", requireLogin, async (req, res) => {
  const { rows } = await pool.query(`
    WITH campaign_rates AS (
      SELECT
        cseg.segment_id,
        c.id AS campaign_id,
        (SELECT COUNT(DISTINCT cr.id) FROM campaign_recipients cr WHERE cr.campaign_id = c.id AND cr.provider_message_id IS NOT NULL) AS sent,
        (SELECT COUNT(DISTINCT ee.campaign_recipient_id) FROM email_events ee WHERE ee.campaign_id = c.id AND ee.event_type = 'delivered') AS delivered,
        (SELECT COUNT(DISTINCT ee.campaign_recipient_id) FROM email_events ee WHERE ee.campaign_id = c.id AND ee.event_type = 'opened') AS opened,
        (SELECT COUNT(DISTINCT ee.campaign_recipient_id) FROM email_events ee WHERE ee.campaign_id = c.id AND ee.event_type = 'clicked') AS clicked
      FROM campaign_segments cseg
      JOIN campaigns c ON c.id = cseg.campaign_id
      WHERE cseg.segment_id IS NOT NULL
    ),
    segment_perf AS (
      SELECT
        segment_id,
        COUNT(*)::int AS campaigns_sent,
        AVG(CASE WHEN delivered > 0 THEN opened::numeric / delivered END) AS avg_open_rate,
        AVG(CASE WHEN delivered > 0 THEN clicked::numeric / delivered END) AS avg_click_rate
      FROM campaign_rates
      GROUP BY segment_id
    )
    SELECT s.id, s.name, s.description, s.created_at,
           COUNT(DISTINCT cs.contact_id)::int AS contact_count,
           COUNT(DISTINCT cs.contact_id) FILTER (WHERE c.status = 'active')::int AS active_count,
           COUNT(DISTINCT cs.contact_id) FILTER (WHERE c.status = 'unsubscribed')::int AS unsubscribed_count,
           COALESCE(sp.campaigns_sent, 0) AS campaigns_sent,
           sp.avg_open_rate,
           sp.avg_click_rate
    FROM segments s
    LEFT JOIN contact_segments cs ON cs.segment_id = s.id
    LEFT JOIN contacts c ON c.id = cs.contact_id
    LEFT JOIN segment_perf sp ON sp.segment_id = s.id
    GROUP BY s.id, sp.campaigns_sent, sp.avg_open_rate, sp.avg_click_rate
    ORDER BY s.name
  `);
  res.json({ segments: rows });
});

// POST /api/segments  { name, description }
router.post("/", requireLogin, async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Segment name is required." });
  }
  try {
    const result = await pool.query(
      "INSERT INTO segments (name, description) VALUES ($1, $2) RETURNING id",
      [name.trim(), (description || "").trim()]
    );
    res.json({ ok: true, segment: await getSegmentWithCount(result.rows[0].id) });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "A segment with that name already exists." });
    }
    console.error("[segments] create failed:", err.message);
    res.status(500).json({ error: "Could not create segment." });
  }
});

// PUT /api/segments/:id  { name, description } - rename / edit description
router.put("/:id", requireLogin, async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Segment name is required." });
  }
  const existing = await pool.query("SELECT id FROM segments WHERE id = $1", [req.params.id]);
  if (!existing.rows.length) return res.status(404).json({ error: "Segment not found." });

  try {
    await pool.query("UPDATE segments SET name = $1, description = $2 WHERE id = $3", [
      name.trim(), (description || "").trim(), req.params.id,
    ]);
    res.json({ ok: true, segment: await getSegmentWithCount(req.params.id) });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "A segment with that name already exists." });
    }
    console.error("[segments] update failed:", err.message);
    res.status(500).json({ error: "Could not update segment." });
  }
});

// DELETE /api/segments/:id - deletes the segment + its memberships only.
// Contacts themselves are never touched (ON DELETE CASCADE only clears the
// contact_segments join rows; campaign_segments keeps its segment_name
// snapshot for historical campaigns regardless).
router.delete("/:id", requireLogin, async (req, res) => {
  const existing = await pool.query("SELECT id FROM segments WHERE id = $1", [req.params.id]);
  if (!existing.rows.length) return res.status(404).json({ error: "Segment not found." });
  await pool.query("DELETE FROM segments WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// GET /api/segments/:id/contacts - contacts currently in a segment
router.get("/:id/contacts", requireLogin, async (req, res) => {
  const segmentResult = await pool.query("SELECT id, name FROM segments WHERE id = $1", [req.params.id]);
  if (!segmentResult.rows.length) return res.status(404).json({ error: "Segment not found." });

  const { rows: contacts } = await pool.query(`
    SELECT c.id, c.name, c.email, c.status
    FROM contacts c
    JOIN contact_segments cs ON cs.contact_id = c.id
    WHERE cs.segment_id = $1
    ORDER BY c.created_at DESC
  `, [req.params.id]);

  res.json({ segment: segmentResult.rows[0], contacts });
});

// POST /api/segments/:id/contacts  { contactIds: [1,2,3] } - add contacts to segment
router.post("/:id/contacts", requireLogin, async (req, res) => {
  const { contactIds } = req.body;
  const existing = await pool.query("SELECT id FROM segments WHERE id = $1", [req.params.id]);
  if (!existing.rows.length) return res.status(404).json({ error: "Segment not found." });
  if (!Array.isArray(contactIds) || !contactIds.length) {
    return res.status(400).json({ error: "No contacts selected." });
  }

  await pool.query(`
    INSERT INTO contact_segments (contact_id, segment_id)
    SELECT unnest($1::bigint[]), $2
    ON CONFLICT DO NOTHING
  `, [contactIds, req.params.id]);

  res.json({ ok: true, segment: await getSegmentWithCount(req.params.id) });
});

// DELETE /api/segments/:id/contacts  { contactIds: [1,2,3] } - remove contacts from segment
router.delete("/:id/contacts", requireLogin, async (req, res) => {
  const { contactIds } = req.body;
  const existing = await pool.query("SELECT id FROM segments WHERE id = $1", [req.params.id]);
  if (!existing.rows.length) return res.status(404).json({ error: "Segment not found." });
  if (!Array.isArray(contactIds) || !contactIds.length) {
    return res.status(400).json({ error: "No contacts selected." });
  }

  await pool.query(
    "DELETE FROM contact_segments WHERE contact_id = ANY($1::bigint[]) AND segment_id = $2",
    [contactIds, req.params.id]
  );

  res.json({ ok: true, segment: await getSegmentWithCount(req.params.id) });
});

module.exports = router;
