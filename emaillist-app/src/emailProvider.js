// Email provider abstraction.
//
// To switch providers later, write a new file that exports the same
// sendEmail() / testConnection() / configStatus() functions, and change the
// require() wherever this file is imported. Nothing else in the app needs
// to change.
//
// IMPORTANT: env vars are read fresh on every call (not cached once at
// module load). This avoids a real footgun: if RESEND_API_KEY is added to
// your hosting provider's dashboard after the server process already
// started, a module-load-time cache would stay stuck seeing it as "missing"
// until the next restart. Reading it per-call means it just works as soon
// as the platform actually injects it into the running process.

const { Resend } = require("resend");

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return "****";
  return `${key.slice(0, 6)}...${key.slice(-4)} (${key.length} chars)`;
}

// Non-secret snapshot of the current email configuration, safe to send to
// the frontend for the Settings diagnostic panel. Never includes the key.
function configStatus() {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.FROM_EMAIL;
  return {
    hasApiKey: !!apiKey,
    apiKeyMasked: maskKey(apiKey),
    fromEmail: fromEmail || null,
    fromName: process.env.FROM_NAME || null,
    configured: !!apiKey && !!fromEmail,
  };
}

async function sendEmail({ to, subject, html, fromEmail, fromName }) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.error("[email] Blocked send: RESEND_API_KEY is not set in this environment.");
    return {
      ok: false,
      code: "missing_api_key",
      error: "RESEND_API_KEY is not set in this environment. Add it in your hosting provider's environment variables (a local .env file is not enough in production) and redeploy/restart.",
    };
  }
  if (!fromEmail) {
    console.error("[email] Blocked send: FROM_EMAIL is not set in this environment.");
    return {
      ok: false,
      code: "missing_from_email",
      error: "FROM_EMAIL is not set in this environment.",
    };
  }

  const client = new Resend(apiKey);
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

  console.log(`[email] Calling Resend — key ${maskKey(apiKey)}, from "${from}", to "${to}", subject "${subject}"`);

  let response;
  try {
    response = await client.emails.send({ from, to, subject, html });
  } catch (err) {
    // A thrown exception means the request never got a proper Resend
    // response at all (network failure, SDK misuse, etc).
    console.error("[email] Request to Resend threw an exception:", err && err.message ? err.message : err);
    return { ok: false, code: "network_error", error: (err && err.message) || String(err) };
  }

  const { data, error } = response || {};

  if (error) {
    // The Resend SDK does NOT throw on API-level errors (bad key, unverified
    // domain, etc) - it returns them in this `error` field. This is exactly
    // the case the previous version of this app was not checking closely
    // enough for.
    console.error("[email] Resend rejected the request:", error);
    return { ok: false, code: "resend_error", error: error.message || JSON.stringify(error) };
  }

  if (!data || !data.id) {
    // Defensive: neither an error nor a normal-looking success payload.
    console.error("[email] Resend returned an unexpected response shape:", response);
    return { ok: false, code: "unexpected_response", error: "Resend returned a response with no error and no email id - treating this as not sent." };
  }

  console.log(`[email] Resend accepted the request — id: ${data.id}`);
  return { ok: true, id: data.id };
}

// Lightweight check that the configured API key actually authenticates
// against Resend, without sending a real email. Used by the "Test Resend
// Connection" diagnostic.
async function testConnection() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, code: "missing_api_key", error: "RESEND_API_KEY is not set in this environment." };
  }

  const client = new Resend(apiKey);
  try {
    const { data, error } = await client.apiKeys.list();
    if (error) {
      console.error("[email] Resend connection test failed:", error);
      return { ok: false, code: "resend_error", error: error.message || JSON.stringify(error) };
    }
    const count = data && Array.isArray(data.data) ? data.data.length : undefined;
    console.log(`[email] Resend connection test OK${count !== undefined ? ` (${count} API key(s) visible)` : ""}.`);
    return { ok: true };
  } catch (err) {
    console.error("[email] Resend connection test threw an exception:", err && err.message ? err.message : err);
    return { ok: false, code: "network_error", error: (err && err.message) || String(err) };
  }
}

module.exports = { sendEmail, testConnection, configStatus };
