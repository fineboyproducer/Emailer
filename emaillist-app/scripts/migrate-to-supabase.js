// Migrates data from the app's existing SQLite database into Supabase
// Postgres. Safe to run more than once — every insert uses
// ON CONFLICT ... DO NOTHING keyed on the original id, so re-running this
// after a partial run (or by accident) will not create duplicates.
//
// Usage:
//   npm run migrate                 # uses ./data/app.db
//   npm run migrate -- ./path/to/app.db
//
// Requires:
//   - SUPABASE_DB_URL set in .env (or the environment) — the connection
//     string from Supabase → Project Settings → Database → Connection string
//   - The schema already created (run sql/schema.sql in the Supabase SQL
//     editor first)
//   - better-sqlite3 installed (it's an optionalDependency; if `npm install`
//     skipped it, run `npm install better-sqlite3` once before migrating)

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const sqlitePath = process.argv[2] || path.join(__dirname, "..", "data", "app.db");

async function main() {
  console.log(`\nEmail List — SQLite → Supabase migration`);
  console.log(`==========================================\n`);

  if (!fs.existsSync(sqlitePath)) {
    console.error(`No SQLite database found at ${sqlitePath}.`);
    console.error(`If your data lives elsewhere, run: npm run migrate -- /path/to/app.db`);
    process.exit(1);
  }

  const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("SUPABASE_DB_URL is not set. Add it to your .env first (see .env.example).");
    process.exit(1);
  }

  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (err) {
    console.error("better-sqlite3 isn't installed. Run: npm install better-sqlite3");
    process.exit(1);
  }

  const sqlite = new Database(sqlitePath, { readonly: true });
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("supabase.co") ? { rejectUnauthorized: false } : undefined,
  });

  console.log(`Source:      ${sqlitePath}`);
  console.log(`Destination: ${connectionString.replace(/:[^:@]*@/, ":****@")}\n`);

  try {
    await pool.query("select 1");
  } catch (err) {
    console.error("Could not connect to Supabase Postgres:", err.message);
    console.error("Double-check SUPABASE_DB_URL and that you've run sql/schema.sql first.");
    process.exit(1);
  }

  const summary = [];

  async function copyTable({ name, columns, transformRow }) {
    let rows;
    try {
      rows = sqlite.prepare(`SELECT * FROM ${name}`).all();
    } catch (err) {
      console.log(`  (skipping ${name} — not present in the source database)`);
      summary.push({ table: name, source: 0, inserted: 0, skipped: 0 });
      return;
    }

    let inserted = 0;
    for (const raw of rows) {
      const row = transformRow ? transformRow(raw) : raw;
      const cols = columns;
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const conflictCols = name === "contact_segments"
        ? "(contact_id, segment_id)"
        : name === "campaign_segments"
        ? "(campaign_id, segment_name)"
        : "(id)";
      const sql = `
        INSERT INTO ${name} (${cols.join(", ")})
        VALUES (${placeholders})
        ON CONFLICT ${conflictCols} DO NOTHING
      `;
      const values = cols.map((c) => row[c]);
      const result = await pool.query(sql, values);
      if (result.rowCount > 0) inserted++;
    }

    console.log(`  ${name}: ${rows.length} in SQLite → ${inserted} newly inserted (${rows.length - inserted} already present / skipped)`);
    summary.push({ table: name, source: rows.length, inserted, skipped: rows.length - inserted });
  }

  console.log("Copying data...\n");

  await copyTable({
    name: "contacts",
    columns: ["id", "name", "email", "status", "unsubscribe_token", "created_at"],
  });

  await copyTable({
    name: "segments",
    columns: ["id", "name", "description", "created_at"],
  });

  await copyTable({
    name: "contact_segments",
    columns: ["contact_id", "segment_id"],
  });

  await copyTable({
    name: "campaigns",
    columns: [
      "id", "subject", "sender_name", "body_html", "recipient_count",
      "failed_count", "status", "recipient_mode", "excluded_unsubscribed", "sent_at",
    ],
    // Older SQLite databases created before segmentation may not have these
    // columns; default them so the insert still works.
    transformRow: (row) => ({
      ...row,
      recipient_mode: row.recipient_mode || "all",
      excluded_unsubscribed: row.excluded_unsubscribed || 0,
    }),
  });

  await copyTable({
    name: "campaign_segments",
    columns: ["campaign_id", "segment_id", "segment_name"],
  });

  // Bring each table's auto-increment sequence up past the highest migrated
  // id, so the very next contact/segment/campaign the app creates doesn't
  // collide with a migrated row.
  console.log("\nResyncing id sequences...");
  for (const table of ["contacts", "segments", "campaigns"]) {
    await pool.query(`
      SELECT setval(
        pg_get_serial_sequence('${table}', 'id'),
        COALESCE((SELECT MAX(id) FROM ${table}), 1)
      )
    `);
  }
  console.log("  done.");

  // Verification: compare row counts and a couple of relationship checks.
  console.log("\nVerifying...\n");
  let allOk = true;
  for (const { table, source } of summary) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
    const destCount = rows[0].count;
    const ok = destCount >= source; // >= because a prior run may have already inserted some
    if (!ok) allOk = false;
    console.log(`  ${table}: source had ${source}, Supabase now has ${destCount} ${ok ? "✓" : "✗ MISMATCH"}`);
  }

  const orphanContactSegments = await pool.query(`
    SELECT COUNT(*)::int AS count FROM contact_segments cs
    LEFT JOIN contacts c ON c.id = cs.contact_id
    LEFT JOIN segments s ON s.id = cs.segment_id
    WHERE c.id IS NULL OR s.id IS NULL
  `);
  if (orphanContactSegments.rows[0].count > 0) {
    allOk = false;
    console.log(`  ✗ ${orphanContactSegments.rows[0].count} contact_segments rows reference a missing contact or segment`);
  } else {
    console.log(`  contact_segments relationships: all valid ✓`);
  }

  const orphanCampaignSegments = await pool.query(`
    SELECT COUNT(*)::int AS count FROM campaign_segments cs
    LEFT JOIN campaigns c ON c.id = cs.campaign_id
    WHERE c.id IS NULL
  `);
  if (orphanCampaignSegments.rows[0].count > 0) {
    allOk = false;
    console.log(`  ✗ ${orphanCampaignSegments.rows[0].count} campaign_segments rows reference a missing campaign`);
  } else {
    console.log(`  campaign_segments relationships: all valid ✓`);
  }

  console.log(`\n${allOk ? "Migration complete — everything checks out." : "Migration finished with mismatches above — check them before switching over."}\n`);
  console.log("Your original SQLite file has not been modified or deleted — keep it as a backup");
  console.log(`until you've confirmed the app works correctly against Supabase.\n`);

  await pool.end();
  sqlite.close();
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("\nMigration failed:", err);
  process.exit(1);
});
