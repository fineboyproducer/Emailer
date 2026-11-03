# Website-side export function

Runs in the **website's** Supabase project (the one that holds `event_registrations`), not in the Emailer's.

**Why:** the live page's public key can only insert registrations, never read them, and the Emailer lives in a different Supabase project whose credentials should not be shared. This function is the narrow, authenticated door between them: read-only, one table, only the columns the Emailer needs (never `unsubscribe_token`), at most 14 days back, at most 2000 rows, refused without the shared secret.

## Deploy (about 10 minutes)

1. Generate a secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep it; it goes in two places.
2. In the website's Supabase dashboard: **Edge Functions → Deploy a new function → Via editor**. Name it exactly `export-live-registrations`, paste the whole of `functions/export-live-registrations/index.ts`, deploy. In the function's settings turn **Verify JWT OFF**.
   (Command line instead: `supabase functions deploy export-live-registrations --no-verify-jwt --project-ref <website-project-ref>`.)
3. **Edge Functions → Secrets**, add `LIVE_EXPORT_SECRET` = the secret from step 1. If your functions are not given `SUPABASE_SERVICE_ROLE_KEY` automatically, also add `SERVICE_ROLE_KEY` with the project's secret key (Settings → API Keys). Never put either in Git.
4. Test it (replace the two values; this reads real registrations):
   ```bash
   curl -s "https://<website-project-ref>.supabase.co/functions/v1/export-live-registrations?event=How%20To%20Stop%20Wasting%20Money%20Promoting%20Your%20Songs" \
     -H "x-export-secret: <the secret>" | head -c 600
   ```
   Expect `{"ok":true,...,"registrations":[...]}`. Without the header you must get `{"ok":false,"error":"unauthorized"}`.
5. In Render (Emailer) add `SITE_EXPORT_URL` = `https://<website-project-ref>.supabase.co/functions/v1/export-live-registrations` and `SITE_EXPORT_SECRET` = the same secret. Restart.

## Notes
- If `event_registrations` has no `unsubscribed_at` column the function still works; opt-outs recorded on the website just won't be copied (the response says `"opt_outs_included": false`).
- To switch it off: remove `SITE_EXPORT_SECRET` from Render (the Emailer stops reconciling) or delete the function.
- Rotating the secret: change it in both places; until both match, runs report "unauthorized" and the Actions run goes red.
