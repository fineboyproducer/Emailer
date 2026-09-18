// Postgres (Supabase) connection pool. Replaces the old better-sqlite3
// db.js — every query in this app is now async and goes through here.
//
// Why a direct Postgres connection instead of the Supabase JS client
// (@supabase/supabase-js + SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY)?
// This app's analytics need real SQL: DISTINCT counts, multi-table joins,
// and aggregates (unique opens vs total opens, click-to-open rate, etc).
// That's awkward and slow to express through a REST query builder, and
// straightforward with `pg` + plain SQL. Supabase's own Postgres database
// is still the one and only source of truth — this is just a different,
// more direct way of talking to it. See README.md for the exact connection
// string to use (SUPABASE_DB_URL).

const { Pool } = require("pg");

const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    "FATAL: SUPABASE_DB_URL is not set. The app has no database to connect to.\n" +
    "Add it to your .env (see .env.example) — it's the connection string from\n" +
    "Supabase → Project Settings → Database → Connection string."
  );
}

const pool = new Pool({
  connectionString,
  // Supabase requires SSL. `rejectUnauthorized: false` trusts the
  // connection without verifying Supabase's certificate chain against a
  // local CA bundle - the standard pragmatic setting for connecting to
  // Supabase from most hosting environments (including Render).
  ssl: connectionString && connectionString.includes("supabase.co") ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

pool.on("error", (err) => {
  // Fires for errors on idle clients in the pool (e.g. a dropped
  // connection) - log it, but don't crash the whole server over it.
  console.error("[db] Unexpected error on an idle Postgres client:", err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

// Runs `fn` inside a single client checked out from the pool, wrapped in a
// transaction (BEGIN/COMMIT, with ROLLBACK on error). Use this whenever
// multiple statements need to succeed or fail together — e.g. inserting a
// campaign row plus its campaign_segments rows.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
