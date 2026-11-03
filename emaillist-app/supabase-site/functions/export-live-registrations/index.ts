// =====================================================================================
// export-live-registrations  —  Supabase Edge Function for the WEBSITE's Supabase project
//
// Why this exists: the live page saves each registration to the website's Supabase table,
// and the Emailer (a separate project) must be able to find any registration whose
// browser-to-Emailer hand-off failed. The page's public key can only INSERT (it cannot read),
// and we do not want the website's Supabase credentials copied into the Emailer. So the
// Emailer asks THIS function, which holds the credentials itself, and proves who it is with a
// shared secret.
//
// Read-only. Returns only the fields the Emailer needs (never the unsubscribe token).
//
//   GET ?since=<ISO time>&event=<event name>
//   header  x-export-secret: <LIVE_EXPORT_SECRET>
//
// Deploy with JWT verification OFF (the Emailer has no Supabase login):
//   supabase functions deploy export-live-registrations --no-verify-jwt
// Secrets (Edge Functions > Secrets):
//   LIVE_EXPORT_SECRET   long random string; the same value goes in the Emailer's SITE_EXPORT_SECRET
//   SERVICE_ROLE_KEY     only if the built-in SUPABASE_SERVICE_ROLE_KEY is not provided to your functions
// =====================================================================================

const TABLE = 'event_registrations';
const MAX_ROWS = 2000;
const MAX_LOOKBACK_DAYS = 14;
const DEFAULT_LOOKBACK_DAYS = 8;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const BASE_COLUMNS = 'id,first_name,email,whatsapp,artist_name,event_name,event_date,registered_at';

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);

  const secret = (Deno.env.get('LIVE_EXPORT_SECRET') ?? '').trim();
  if (secret.length < 24) return json({ ok: false, error: 'not_configured' }, 500);   // refuse to run with a weak/missing secret
  if (!safeEqual(req.headers.get('x-export-secret') ?? '', secret)) return json({ ok: false, error: 'unauthorized' }, 401);

  const base = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
  const key = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '').trim();
  if (!base || !key) return json({ ok: false, error: 'not_configured' }, 500);

  const url = new URL(req.url);
  const event = (url.searchParams.get('event') ?? '').trim();
  if (!event || event.length > 200) return json({ ok: false, error: 'event_required' }, 400);

  // `since` is clamped so one call can never dump the whole table.
  const now = Date.now();
  const earliest = now - MAX_LOOKBACK_DAYS * 86400000;
  let sinceMs = Date.parse(url.searchParams.get('since') ?? '');
  if (!Number.isFinite(sinceMs)) sinceMs = now - DEFAULT_LOOKBACK_DAYS * 86400000;
  sinceMs = Math.max(sinceMs, earliest);

  const headers: Record<string, string> = { apikey: key };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;

  const query = (columns: string) =>
    `${base}/rest/v1/${TABLE}?select=${columns}` +
    `&event_name=eq.${encodeURIComponent(event)}` +
    `&registered_at=gte.${encodeURIComponent(new Date(sinceMs).toISOString())}` +
    `&order=registered_at.asc&limit=${MAX_ROWS + 1}`;

  try {
    // Include opt-outs when the column exists. If it does not, retry without it rather than fail.
    let optOutsIncluded = true;
    let res = await fetch(query(BASE_COLUMNS + ',unsubscribed_at'), { headers });
    if (res.status === 400) {
      optOutsIncluded = false;
      res = await fetch(query(BASE_COLUMNS), { headers });
    }
    if (!res.ok) return json({ ok: false, error: 'query_failed', status: res.status }, 502);

    const rows = await res.json();
    if (!Array.isArray(rows)) return json({ ok: false, error: 'unexpected_response' }, 502);

    const truncated = rows.length > MAX_ROWS;
    return json({
      ok: true,
      truncated,
      opt_outs_included: optOutsIncluded,
      since: new Date(sinceMs).toISOString(),
      count: Math.min(rows.length, MAX_ROWS),
      registrations: rows.slice(0, MAX_ROWS),
    });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: 'server_error' }, 500);
  }
});
