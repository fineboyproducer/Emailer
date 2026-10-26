"use strict";

const crypto = require("crypto");
const { withTransaction } = require("../db");
const { liveConfig } = require("./config");
const { nextSession } = require("./session");

const EMAIL_RE = /^[^\s@]+@[^\s@]{1,}\.[^\s@]{2,}$/;

function collapse(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

// Validates and cleans raw input. Returns { ok: true, value } or { ok: false, error }.
function cleanRegistration(input) {
  const firstName = collapse(input && input.first_name);
  const email = collapse(input && input.email).toLowerCase();
  const whatsappRaw = collapse(input && input.whatsapp).replace(/[^\d+]/g, "");
  const artistName = collapse(input && input.artist_name);

  if (!firstName || firstName.length > 80) return { ok: false, error: "A first name (up to 80 characters) is required." };
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, error: "A valid email address is required." };
  if (whatsappRaw && (whatsappRaw.length < 8 || whatsappRaw.length > 20)) return { ok: false, error: "That WhatsApp number doesn't look right." };
  if (artistName.length > 80) return { ok: false, error: "Artist name must be under 80 characters." };

  return { ok: true, value: { firstName, email, whatsapp: whatsappRaw || null, artistName: artistName || null } };
}

// Adds the person to the contact list (never changes the status of an existing contact),
// files them in the live-registrants segment, and records their registration for the
// session they are signing up for. Safe to call twice for the same person and session.
// Returns { registrationId, created, session }.
async function registerLive(clean, { source = "page", registeredAtMs = Date.now() } = {}) {
  const cfg = liveConfig();
  const session = nextSession(registeredAtMs, cfg);

  return withTransaction(async (client) => {
    let contact = (await client.query("SELECT id, name FROM contacts WHERE lower(email) = lower($1)", [clean.email])).rows[0];
    if (!contact) {
      const inserted = await client.query(
        "INSERT INTO contacts (name, email, unsubscribe_token) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id, name",
        [clean.firstName, clean.email, crypto.randomBytes(24).toString("hex")]
      );
      contact = inserted.rows[0] ||
        (await client.query("SELECT id, name FROM contacts WHERE lower(email) = lower($1)", [clean.email])).rows[0];
    } else if (!contact.name) {
      await client.query("UPDATE contacts SET name = $1 WHERE id = $2", [clean.firstName, contact.id]);
    }

    await client.query(
      "INSERT INTO segments (name, description) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [cfg.segmentName, "People who registered for the live masterclass (added automatically)."]
    );
    const segment = (await client.query("SELECT id FROM segments WHERE lower(name) = lower($1)", [cfg.segmentName])).rows[0];
    await client.query(
      "INSERT INTO contact_segments (contact_id, segment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [contact.id, segment.id]
    );

    // A repeat registration for the same Friday updates the details but never clears an
    // unsubscribe: someone typing a stranger's email must not be able to switch their reminders back on.
    const reg = await client.query(
      `INSERT INTO live_registrations
         (contact_id, first_name, email, whatsapp, artist_name, event_name, event_date, registered_at, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (lower(email), event_date) DO UPDATE SET
         contact_id  = EXCLUDED.contact_id,
         first_name  = EXCLUDED.first_name,
         whatsapp    = COALESCE(EXCLUDED.whatsapp, live_registrations.whatsapp),
         artist_name = COALESCE(EXCLUDED.artist_name, live_registrations.artist_name)
       RETURNING id, (xmax = 0) AS created`,
      [contact.id, clean.firstName, clean.email, clean.whatsapp, clean.artistName,
        cfg.eventName, session.dateKey, new Date(registeredAtMs).toISOString(), source]
    );

    return { registrationId: reg.rows[0].id, created: reg.rows[0].created, session };
  });
}

module.exports = { cleanRegistration, registerLive };
