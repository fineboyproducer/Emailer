# Live reminders: runbook

How a live-page registration becomes a confirmation and reminders, what each service needs, how to deploy and verify it, how to tell it is working, and how to back out.

## 1. How it works (as built)

```
Visitor registers on the live page
  → page saves it to the WEBSITE's Supabase (event_registrations). If this fails the visitor sees an error; nothing else happens.
  → page tells the Emailer (POST /api/public/live/register) and waits up to 2.5 s for "ok", then goes on to /blueprint either way
  → Emailer validates, and in one transaction saves contact + segment + live_registrations in ITS OWN Supabase; only then answers "ok"
  → Emailer sends the confirmation right after answering (the next scheduler run retries it if that fails)

Every 5 minutes, GitHub Actions → POST /api/public/live/cron  (also wakes the sleeping Render service)
  1. Reconcile: ask the website project's read-only function for the last 8 days of registrations; import any the Emailer does not have
  2. Send whatever is due (confirmation / Thursday 8 PM / Friday 7 PM / Friday 8 PM, all WAT), claiming each in live_reminder_log first
  3. Answer with a summary; Actions goes red if anything failed or the website could not be read

Resend delivers; delivery/bounce events come back to /api/webhooks/resend
Unsubscribe link in every email → confirm page → stops live reminders only
```

**Differences from the originally intended flow**
- Reminders are not pre-created as scheduled rows. They are worked out on every run from each registration's Friday (`live_registrations.event_date`) and recorded in `live_reminder_log` when claimed. This is what makes repeated, late or overlapping runs safe.
- The confirmation is sent just *after* the "ok", not before it, so a slow email provider can never make a registration look failed.
- Added the reconciliation step (above). Without it, a registration whose hand-off failed would never be found.
- GitHub Actions is the **only** scheduler. Render's free tier sleeps, so something outside it must call in; the Emailer's own timer was removed to avoid two competing schedulers.

**Who decides the event date.** The Emailer, always: it recomputes the Friday from the time the person registered (next Friday 8 PM WAT whose live has not ended). The `event_date` the page sends is only compared and counted as a "mismatch" in the run summary. Someone registering after a live ends is put on the following Friday.

## 2. Configuration

**Emailer (Render).** Already present: `SUPABASE_DB_URL`, `RESEND_API_KEY`, `FROM_EMAIL`, `FROM_NAME`, `RESEND_WEBHOOK_SECRET`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `APP_URL` (must be `https://emailer-0w2b.onrender.com`).

| New variable | Purpose |
|---|---|
| `CRON_SECRET` | protects `/cron` and `/status`; must equal the GitHub secret of the same name |
| `SITE_EXPORT_URL` | `https://<website-project-ref>.supabase.co/functions/v1/export-live-registrations` |
| `SITE_EXPORT_SECRET` | shared secret; must equal `LIVE_EXPORT_SECRET` on that function |

Optional: `LIVE_EMAIL_KINDS` (default `confirm,24h,1h,live`), `LIVE_RECONCILE_DAYS` (8), `LIVE_EVENT_NAME`, `LIVE_WEEKDAY` (5), `LIVE_HOUR_WAT` (20), `LIVE_DURATION_MIN` (60), `LIVE_PAGE_URL`, `LIVE_SEGMENT_NAME`, `LIVE_FROM_NAME`, `LIVE_ALLOWED_ORIGINS`. Node: `package.json` requires `>=18.17`.

**Website's Supabase project.** Edge Function `export-live-registrations` (source in `supabase-site/`), secret `LIVE_EXPORT_SECRET`, JWT verification off. Nothing else changes. The Emailer never receives that project's credentials.

**GitHub (Emailer repo → Settings → Secrets and variables → Actions):** `EMAILER_URL` = `https://emailer-0w2b.onrender.com`, `CRON_SECRET`.

**Website (`live/index.html`):** `CONFIG.EMAILER_URL` = `https://emailer-0w2b.onrender.com` (public address, no secret).

**Databases.** Emailer project: `sql/02_live_reminders.sql` creates `live_registrations` and `live_reminder_log` (idempotent; also runs at startup; nothing existing is altered). Website project: unchanged.

## 3. Before going live: checks on the website database

Run in the website project's SQL editor. These are reads.

```sql
-- 1. A repeat registrant (same email, next Friday) must not be blocked. The unique index must include event_date.
select indexname, indexdef from pg_indexes where tablename = 'event_registrations';

-- 2. The columns the Emailer reads.
select column_name, data_type from information_schema.columns
where table_name = 'event_registrations' order by column_name;
```

- If the unique index is only `(lower(email), event_name)`: the page treats a repeat sign-up as success but saves no new row, so the reconciliation can never see that person's new registration (only the fast path can). Fix it:
  ```sql
  create unique index if not exists event_registrations_email_event_date_uniq
    on public.event_registrations (lower(email), event_name, event_date);
  drop index if exists public.event_registrations_email_event_uniq;
  ```
  Create the new index first, then drop the old one. Existing rows are unaffected.
- If `unsubscribed_at` is missing the integration still works; opt-outs recorded on the website are just not copied.

## 4. Deployment order

Today's timeline matters: the Thursday 8 PM WAT "tomorrow" reminder has a window until 11:50 PM; everything below should be done and verified before it.

1. **Website project:** deploy the export function and test it (`supabase-site/README.md`, steps 1–4). Run the two checks in section 3.
2. **Render:** add `CRON_SECRET`, `SITE_EXPORT_URL`, `SITE_EXPORT_SECRET`. To test before merging, set the service's branch to `live-reminders-integration-v2` (Settings → Build & Deploy) and let it deploy; set it back to `main` after the merge.
3. **Check the Emailer is healthy:** `curl https://emailer-0w2b.onrender.com/api/public/live/health` → `{"ok":true}` (the first call after sleep can take up to a minute).
4. **Rehearse:**
   ```bash
   curl -s -X POST "https://emailer-0w2b.onrender.com/api/public/live/cron?dry_run=1" -H "x-cron-secret: <CRON_SECRET>"
   ```
   Writes and sends nothing. Read `reconcile.wouldImport` (registrations the Emailer does not have yet) and `would_send` (the emails that would go out, masked). **Every existing registrant for the upcoming Friday will get one late "You're in" email on the first real run.** If you do not want that, set `LIVE_EMAIL_KINDS=24h,1h,live` for the first run, then remove it.
5. **GitHub secrets:** add `EMAILER_URL` and `CRON_SECRET`.
6. **Merge the Emailer branch to `main`** (this puts the workflow on the default branch, where GitHub runs schedules). Render redeploys.
7. **Run the workflow once by hand:** Actions → Live reminders → Run workflow. It must go green. Then check `/api/public/live/status` (below).
8. **Merge the website branch to `main`** (GitHub Pages publishes it).
9. **Controlled production registration** with an address you own, from the live page:
   - you land on /blueprint;
   - the confirmation email arrives (seconds if Render was awake; within about 5 minutes otherwise);
   - the row exists in the website's `event_registrations` **and** the Emailer's `live_registrations`;
   - the unsubscribe link in the email shows a confirm button, and nothing changes until you press it;
   - then remove the test rows: in the Emailer's project `delete from live_registrations where email = '<yours>';`, and in the website's project the same on `event_registrations`.
10. **Watch the first real registrations** (section 5).

## 5. Is it working?

```bash
curl -s "https://emailer-0w2b.onrender.com/api/public/live/status" -H "x-cron-secret: <CRON_SECRET>"
```
Shows the next live, registrations (how many came through the page vs. were recovered by reconciliation), how many of each email were sent/failed, anyone still awaiting a confirmation, and recent failures (emails masked).

Emailer's Supabase SQL:
```sql
select event_date, count(*) from live_registrations group by 1 order by 1 desc;
select kind, status, count(*) from live_reminder_log group by 1, 2 order by 1, 2;
select r.email, l.kind, l.attempts, l.error from live_reminder_log l join live_registrations r on r.id = l.registration_id
 where l.status = 'failed' order by l.updated_at desc;
```
After each live: the count for that Friday in `live_registrations` should equal the count of that Friday's rows in the website's `event_registrations` (minus any invalid or opted-out ones).

Also: GitHub Actions tab (a green run every 5 minutes), Resend dashboard (delivered / bounced), Render logs (`[live]` lines).

## 6. When something goes wrong

| Problem | What happens | What to do |
|---|---|---|
| Render is down or asleep | Registrations still save on the website. The page's request may fail. | Wake/restart Render. The next scheduler run imports everything missed and sends the confirmations. Nothing to re-enter. |
| Actions run is red: "website export failed … unauthorized" | Reminders still go out; new registrations are not imported | `SITE_EXPORT_SECRET` (Render) and `LIVE_EXPORT_SECRET` (website function) differ. Make them equal. |
| Actions run is red: "unreachable"/timed out | same | Check the website function is deployed and its URL is right; Supabase status |
| Run is red: failed sends | Retried up to 3 times, 5 minutes apart | `/status` → `failures` shows the reason. Typical: sender domain not verified, daily limit reached, bad address |
| A person says they got nothing | | `/status` (are they in `registrations`? `awaitingConfirmation`?). If they are in the website table but not the Emailer: wait one run; if still missing, check their row is valid (email format, name length) |
| A reminder was missed because the scheduler was down | Windows are 24h: Thu 8:00–11:50 PM, 1h: Fri 7:00–7:30 PM, live: Fri 8:00–8:30 PM WAT. Outside its window a reminder is skipped on purpose, never sent late. | Send one manually from the admin "Create Email" page to the **Live Registrants** segment |
| Actions stopped | GitHub pauses schedules after 60 days without repository activity | Actions tab → re-enable. Any cron service that POSTs the endpoint with the `x-cron-secret` header every 5 minutes works the same |
| Someone complains of duplicates | Should be impossible (unique row per person per reminder). | Check `live_reminder_log`; send me the rows |

**Capacity.** Each registrant can get up to 4 emails over the week: the confirmation (any day), 1 on Thursday, 2 on Friday. A free Resend plan has been 100 emails/day; that figure must be confirmed in the account. At 100/day Friday alone (2 per person) is full at 50 registrants. Reduce with `LIVE_EMAIL_KINDS` (e.g. `confirm,1h`) or upgrade for the week.

## 7. Roll back

1. **Stop new hand-offs:** set `EMAILER_URL: ''` in `live/index.html` and push. The page returns to exactly its previous behaviour (save to Supabase, redirect to /blueprint).
2. **Stop the scheduler:** disable "Live reminders" in the Actions tab, or remove `CRON_SECRET` from Render (the endpoint then refuses every call). Reconciliation stops with it.
3. **Revert the Emailer:** in Render redeploy the last good deploy (or revert the merge). The new tables are additive; leave them.
4. **Website function:** delete `export-live-registrations` or rotate/remove `LIVE_EXPORT_SECRET`. Nothing else depends on it.

Merge commits are reverted with `git revert -m 1 <merge commit>`; no history needs rewriting.
