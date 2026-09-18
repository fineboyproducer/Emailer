const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");
const { pool, withTransaction } = require("../db");
const { requireLogin } = require("../middleware/auth");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

// Attach each contact's segments (id + name) in one extra query, keyed by contact id.
async function attachSegments(contacts) {
  if (!contacts.length) return contacts;
  const ids = contacts.map((c) => c.id);
  const { rows } = await pool.query(
    `SELECT cs.contact_id, s.id, s.name
     FROM contact_segments cs
     JOIN segments s ON s.id = cs.segment_id
     WHERE cs.contact_id = ANY($1::bigint[])
     ORDER BY s.name`,
    [ids]
  );

  const byContact = new Map();
  for (const row of rows) {
    if (!byContact.has(row.contact_id)) byContact.set(row.contact_id, []);
    byContact.get(row.contact_id).push({ id: row.id, name: row.name });
  }
  return contacts.map((c) => ({ ...c, segments: byContact.get(c.id) || [] }));
}

// GET /api/contacts?search=&status=&segmentId= - list contacts, with filters
router.get("/", requireLogin, async (req, res) => {
  const { search, status, segmentId } = req.query;
  const where = [];
  const params = [];

  if (status === "active" || status === "unsubscribed") {
    params.push(status);
    where.push(`c.status = $${params.length}`);
  }
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    where.push(`(c.name ILIKE $${params.length} OR c.email ILIKE $${params.length})`);
  }
  if (segmentId) {
    params.push(segmentId);
    where.push(`c.id IN (SELECT contact_id FROM contact_segments WHERE segment_id = $${params.length})`);
  }

  const sql = `
    SELECT c.id, c.name, c.email, c.status, c.created_at
    FROM contacts c
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY c.created_at DESC
  `;
  try {
    const { rows } = await pool.query(sql, params);
    const contacts = await attachSegments(rows);
    res.json({ contacts });
  } catch (err) {
    console.error("[contacts] list failed:", err.message);
    res.status(500).json({ error: "Could not load contacts." });
  }
});

// POST /api/contacts - add one contact manually
router.post("/", requireLogin, async (req, res) => {
  const { name, email } = req.body;
  if (!email || !EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ error: "A valid email address is required." });
  }
  try {
    await pool.query(
      `INSERT INTO contacts (name, email, unsubscribe_token) 
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING`,
      [(name || "").trim(), String(email).trim().toLowerCase(), makeToken()]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23505") { // unique_violation safety check
      return res.status(409).json({ error: "That email is already on your list." });
    }
    console.error("[contacts] add failed:", err.message);
    res.status(500).json({ error: "Could not add contact." });
  }
});

// DELETE /api/contacts/:id
router.delete("/:id", requireLogin, async (req, res) => {
  await pool.query("DELETE FROM contacts WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// POST /api/contacts/bulk-delete  { ids: [1,2,3] }
router.post("/bulk-delete", requireLogin, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: "No contacts selected." });
  }
  await pool.query("DELETE FROM contacts WHERE id = ANY($1::bigint[])", [ids]);
  res.json({ ok: true, deleted: ids.length });
});

// POST /api/contacts/upload
// - CSV columns: Name, Email, and optionally Segment
// - Optional form field `segmentId`: every imported/matched contact is also
//   added to this existing segment, regardless of a per-row Segment column.
// - A per-row Segment column creates that segment automatically if it
//   doesn't exist yet, and adds the contact to it.
router.post("/upload", requireLogin, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  let records;
  try {
    records = parse(req.file.buffer.toString("utf8"), {
      columns: (header) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
    });
  } catch (err) {
    return res.status(400).json({ error: "Could not parse that file. Make sure it's a valid CSV." });
  }

  if (!records.length || !("email" in records[0])) {
    return res.status(400).json({ error: "CSV must have a header row with at least an 'Email' column (and optionally 'Name' and 'Segment')." });
  }

  const targetSegmentId = req.body.segmentId ? Number(req.body.segmentId) : null;
  if (targetSegmentId) {
    const { rows } = await pool.query("SELECT 1 FROM segments WHERE id = $1", [targetSegmentId]);
    if (!rows.length) return res.status(400).json({ error: "That segment no longer exists." });
  }

  let added = 0, skippedInvalid = 0, skippedDuplicate = 0;
  const seenInFile = new Set();
  const segmentCache = new Map(); // name.toLowerCase() -> id
  const createdSegments = new Set();

  try {
    await withTransaction(async (client) => {
      async function resolveSegmentId(name) {
        const key = name.trim().toLowerCase();
        if (!key) return null;
        if (segmentCache.has(key)) return segmentCache.get(key);
        
        // Atomically fetch or create segment without unique constraints failing
        const { rows } = await client.query(
          `INSERT INTO segments (name) VALUES ($1)
           ON CONFLICT (lower(name)) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [name.trim()]
        );
        const id = rows[0].id;
        segmentCache.set(key, id);
        return id;
      }

      for (const row of records) {
        const email = String(row.email || "").trim().toLowerCase();
        const name = String(row.name || "").trim();
        const segmentName = row.segment ? String(row.segment).trim() : "";

        if (!email || !EMAIL_RE.test(email)) {
          skippedInvalid++;
          continue;
        }

        let contactId = null;

        if (seenInFile.has(email)) {
          skippedDuplicate++;
          // Fetch existing contact ID for segment association
          const existing = await client.query("SELECT id FROM contacts WHERE lower(email) = lower($1)", [email]);
          contactId = existing.rows[0] ? existing.rows[0].id : null;
        } else {
          seenInFile.add(email);

          // Atomic insert or non-destructive update
          const result = await client.query(
            `INSERT INTO contacts (name, email, unsubscribe_token)
             VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE SET
               name = CASE 
                 WHEN EXCLUDED.name IS NOT NULL AND EXCLUDED.name != '' THEN EXCLUDED.name 
                 ELSE contacts.name 
               END
             RETURNING id, (xmax = 0) AS is_inserted`,
            [name, email, makeToken()]
          );

          contactId = result.rows[0].id;
          const isInserted = result.rows[0].is_inserted;

          if (isInserted) {
            added++;
          } else {
            skippedDuplicate++;
          }
        }

        if (contactId) {
          if (segmentName) {
            const segId = await resolveSegmentId(segmentName);
            await client.query(
              "INSERT INTO contact_segments (contact_id, segment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
              [contactId, segId]
            );
          }
          if (targetSegmentId) {
            await client.query(
              "INSERT INTO contact_segments (contact_id, segment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
              [contactId, targetSegmentId]
            );
          }
        }
      }
    });
  } catch (err) {
    console.error("[contacts] CSV import failed:", err.message);
    return res.status(500).json({ error: "Import failed partway through - no changes were saved. " + err.message });
  }

  res.json({
    ok: true,
    added,
    skippedInvalid,
    skippedDuplicate,
    createdSegments: Array.from(createdSegments),
  });
});

// GET /api/contacts/export - download CSV of contacts (with their segments)
router.get("/export", requireLogin, async (req, res) => {
  const { rows } = await pool.query("SELECT id, name, email, status FROM contacts ORDER BY created_at");
  const contacts = await attachSegments(rows);
  const csvRows = contacts.map((c) => ({
    name: c.name,
    email: c.email,
    status: c.status,
    segments: c.segments.map((s) => s.name).join("; "),
  }));
  const csv = stringify(csvRows, { header: true, columns: ["name", "email", "status", "segments"] });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=contacts.csv");
  res.send(csv);
});

// GET /api/contacts/:id - single contact with segments (used by the contact detail page)
router.get("/:id", requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, email, status, created_at FROM contacts WHERE id = $1",
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Contact not found." });
  const [contact] = await attachSegments(rows);
  res.json({ contact });
});

// GET /api/contacts/:id/activity - recent email activity for the contact detail page.
router.get("/:id/activity", requireLogin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT ee.event_type, ee.link_url, ee.occurred_at, c.id AS campaign_id, c.subject AS campaign_subject
    FROM email_events ee
    LEFT JOIN campaigns c ON c.id = ee.campaign_id
    WHERE ee.contact_id = $1
    ORDER BY ee.occurred_at DESC
    LIMIT 30
  `, [req.params.id]);
  res.json({ activity: rows });
});

module.exports = router;