# Email List

A personal email marketing platform: contacts, segments, campaigns, and
real delivery/engagement analytics — backed by Supabase (Postgres) for
storage and Resend for sending + event data. Built to stay a tool one
person can run and understand, not a SaaS product.

## Architecture

```
Render      → hosts the Node/Express app (stateless — holds no data itself)
Supabase    → Postgres database; the only source of truth for all data
Resend      → sends emails, and reports delivery/open/click/bounce/etc
              events back to the app via a webhook
```

Nothing important is stored on Render's local disk anymore. The app can
restart, redeploy, or sleep on Render's free tier without losing anything —
all of it lives in Supabase.

## What's in this upgrade

**1. Database moved from SQLite to Supabase Postgres.** Every route that
used to call `better-sqlite3`'s synchronous `db.prepare(...).get/all/run()`
now runs an async query against Postgres via the `pg` package
(`src/db.js`). Contacts, segments, contact/segment relationships, and
campaigns keep the same shape as before, just in Postgres.

**2. Campaign recipients and analytics, from Resend webhooks.** New tables:
- `campaign_recipients` — one row per contact per campaign sent, with the
  Resend message id and a running status.
- `email_events` — an append-only log of everything Resend tells us
  (sent, delivered, delivery_delayed, bounced, complained, opened,
  clicked) plus unsubscribes recorded by this app directly. This is the
  source of truth analytics are computed from.

A new webhook endpoint, `POST /api/webhooks/resend`, receives these events,
verifies they actually came from Resend, and stores them idempotently (a
redelivered event never gets counted twice).

**3. Real campaign reports.** Click any campaign for delivery (sent,
delivered, delivery rate, bounced, bounce rate, delayed), engagement
(unique vs. total opens, unique vs. total clicks, open rate, click rate,
click-to-open rate), list health (unsubscribes, complaints, and their
rates), and a top-clicked-links table.

**4. Dashboard and segment-level stats**, plus a per-contact activity feed
("Sept 17 — Opened...", "Sept 16 — Clicked...").

Why Postgres directly (via `SUPABASE_DB_URL`) rather than the Supabase JS
client (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`)? The analytics here
need real SQL — `DISTINCT` counts for unique opens/clicks, multi-table
joins, rate calculations — which is awkward and slow through a REST query
builder, and natural with plain SQL. Supabase's Postgres database is still
the single source of truth either way; this is just a more direct way of
talking to it. You will **not** need `SUPABASE_URL` or
`SUPABASE_SERVICE_ROLE_KEY` for anything in this app.

Everything else — auth, {{name}}/{{email}} personalization, unsubscribe,
CSV import/export, segmentation UI, the Resend provider abstraction, and
the visual style — is unchanged in behavior.

---

## Setup guide

### 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) → New Project.
2. Pick a name, a database password (save it — you'll need it for the
   connection string), and a region close to you or your Render service.
3. Wait for it to finish provisioning (a couple of minutes).

### 2. Create the database schema

1. In your Supabase project, open **SQL Editor → New query**.
2. Paste the entire contents of `sql/schema.sql` (in this project) and run
   it. It creates `contacts`, `segments`, `contact_segments`, `campaigns`,
   `campaign_segments`, `campaign_recipients`, and `email_events`, with
   their indexes.
3. This is safe to run more than once — everything uses
   `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`.

### 3. Get your Supabase connection string

Project Settings → Database → **Connection string** → URI. Use the
**Transaction pooler** string (port `6543`) rather than the direct
connection (port `5432`) — it handles the many short-lived connections a
web app makes much better. Fill in the password you set in step 1. It'll
look like:

```
postgresql://postgres.xxxxxxxxxxxx:[PASSWORD]@aws-0-region.pooler.supabase.com:6543/postgres
```

This is your `SUPABASE_DB_URL`.

### 4. Migrate your existing SQLite data

If you have a real `data/app.db` from the current deployment:

1. Make sure you have it locally (download it from Render if needed — see
   your platform's docs for copying a file off a running service, or if
   you still have local dev data, use that).
2. Set `SUPABASE_DB_URL` in your local `.env`.
3. Run:
   ```bash
   npm install
   npm run migrate
   ```
   (if `better-sqlite3` didn't install automatically, run
   `npm install better-sqlite3` once first — it's an optional dependency
   since production no longer needs it).
4. Read the summary it prints: it reports how many rows it found in
   SQLite, how many it inserted into Supabase, and runs verification
   checks (row counts, and that every `contact_segments`/`campaign_segments`
   row points at something that actually exists).
5. It's safe to run again if anything looks off — every insert uses
   `ON CONFLICT ... DO NOTHING` keyed on the original id, so re-running
   never creates duplicates.
6. Your original SQLite file is never modified or deleted by this script —
   keep it until you've fully verified the app on Supabase.

If you don't have real data yet (a fresh install), skip this — the schema
from step 2 is all you need, and the app will just start with an empty
database.

### 5. Configure Resend

Unchanged from before, if you already have this: a verified sending domain
(or `onboarding@resend.dev` for early testing) and an API key from
Resend → API Keys.

### 6. Create the Resend webhook

This is what makes analytics work.

1. Deploy the app first (step 7) so you have a real public URL — the
   webhook needs a live endpoint to point at.
2. In Resend: **Webhooks → Add Webhook**.
3. Endpoint URL: `https://YOUR-RENDER-APP.onrender.com/api/webhooks/resend`
4. Events to send: select `email.sent`, `email.delivered`,
   `email.delivery_delayed`, `email.bounced`, `email.complained`,
   `email.opened`, `email.clicked`.
5. Save it, then open it again and copy the **Signing Secret** (starts
   with `whsec_`). That's your `RESEND_WEBHOOK_SECRET`.
6. Add `RESEND_WEBHOOK_SECRET` to Render's environment variables (step 7)
   and redeploy.

Every incoming webhook is verified against this secret (HMAC-SHA256 over
the exact raw request body, per Resend/Svix's signing scheme) before
anything in it is trusted or stored — an unsigned or incorrectly-signed
request is rejected with `400` and never touches the database.

### 7. Configure Render

In your Render service → **Environment**, set all of:

| Variable | Value |
|---|---|
| `SUPABASE_DB_URL` | from step 3 |
| `RESEND_API_KEY` | from Resend → API Keys |
| `FROM_EMAIL` | your verified sender address |
| `FROM_NAME` | display name for outgoing emails |
| `RESEND_WEBHOOK_SECRET` | from step 6 (add this *after* first deploying, once the webhook exists) |
| `ADMIN_PASSWORD` | your login password for the app |
| `SESSION_SECRET` | a long random string |
| `APP_URL` | your real Render URL, e.g. `https://your-app.onrender.com` |

After adding or changing any of these, **redeploy or manually restart the
service** — most platforms don't apply env var changes to an
already-running process.

You no longer need Render's persistent disk feature for this app (if you'd
set one up for the old SQLite file, it's safe to remove) — nothing writes
to local disk anymore.

### 8. How to test email sending

1. Open `/settings.html` on the deployed app. It should show "Configured"
   and your masked API key / from address.
2. Click **Test Resend Connection** — this authenticates against Resend
   directly, no email sent, so it isolates "is the key valid" from "did
   sending work."
3. Go to **Create Email → Send Test Email**. On success you'll see a real
   Resend message ID. On failure you'll see Resend's actual error message
   (never a fake "sent successfully").
4. Check your [Resend Emails log](https://resend.com/emails) for that
   message ID or recipient address — it should appear immediately.

### 9. How to test analytics

1. Send a real campaign to a small test segment (a segment with just your
   own email addresses is perfect for this).
2. Open the campaign, then open the email in your inbox — click a link in
   it, and optionally mark it as read in different clients to see how open
   tracking behaves.
3. Give it a minute for Resend to deliver the webhook events, then refresh
   the campaign report page (`/campaign.html?id=...`). You should see
   Delivered, Opened, and Clicked move from 0 as events arrive.
4. Open two different links in the email a couple of times each — the
   **Top clicked links** table should show total vs. unique clicks
   correctly (e.g. clicking the same link 3 times shows total clicks = 3,
   unique clicks = 1).
5. Click the unsubscribe link — the campaign report's "Unsubscribed" count
   should increment, and the contact's page should show "Unsubscribed"
   in their activity feed.
6. To directly confirm webhook delivery, check Resend → Webhooks → your
   endpoint → recent deliveries; each should show a `200` response from
   your app. Your Render logs will also show a `[webhook] email.xxx for
   message ... — stored` line for each one processed.

### 10. How to verify data persists after Render restarts

1. Note your current contact/campaign counts on the dashboard.
2. In Render, manually restart the service (or just wait for the free tier
   to sleep and wake back up on the next request).
3. Reload the dashboard — the counts should be identical. Nothing should
   have reset, because none of it was ever stored on Render's disk.

### 11. How to safely retire the old SQLite database

Once you've confirmed (via steps 8–10) that the app is fully working
against Supabase:

- The `data/app.db` file is no longer read by the running app at all —
  `src/db.js` only talks to Postgres now. You can leave it in place
  untouched, or move it somewhere else as a cold backup.
- Do **not** delete it immediately. Keep it for a while (a few weeks is
  reasonable) in case you spot a data discrepancy and need to re-run or
  cross-check the migration.
- When you're confident, it's just a file — delete it locally/from
  wherever you stored the backup whenever you're ready. There's no
  in-app "retire SQLite" step needed since the app never touches it.

---

## Environment variables (full list)

| Variable | Required | Notes |
|---|---|---|
| `SUPABASE_DB_URL` | Yes | Postgres connection string (pooler, port 6543) |
| `RESEND_API_KEY` | Yes | From Resend → API Keys |
| `FROM_EMAIL` | Yes | Must be on a domain verified in Resend |
| `FROM_NAME` | No | Display name for outgoing emails |
| `RESEND_WEBHOOK_SECRET` | Yes, for analytics | Without it, sending still works but no delivery/open/click/etc data is recorded |
| `ADMIN_PASSWORD` | Yes | Your login password |
| `SESSION_SECRET` | Yes | Random string signing login sessions |
| `APP_URL` | Yes | Your deployed URL — used for unsubscribe links |
| `PORT` | No | Most hosts set this automatically |

## How the analytics numbers are calculated

- **Sent** = recipients Resend actually accepted the API call for (has a
  Resend message id). **Recipients** = everyone the campaign targeted,
  including any that failed outright.
- **Delivered / Bounced / Delayed / Opened / Clicked / Complained** are
  each a `COUNT(DISTINCT recipient)` from `email_events` — so "unique"
  metrics genuinely dedupe repeat opens/clicks from the same person, while
  "total opens"/"total clicks" count every event.
- **Delivery rate** = delivered ÷ sent. **Open rate** and **click rate** =
  unique opens/clicks ÷ delivered (the standard denominator — a bounced
  email was never delivered, so it can't be "opened"). **Click-to-open
  rate** = unique clicks ÷ unique opens. **Bounce/unsubscribe/complaint
  rate** = that count ÷ delivered.
- **Segment averages** (Segments page) average each campaign's own rate
  across campaigns that *targeted* that segment at send time (from the
  `campaign_segments` snapshot) — not by looking at who's in the segment
  today. A campaign with 0 delivered emails isn't included in the average.
- Every campaign's targeted segments are frozen at send time
  (`campaign_segments`). Moving a contact to a different segment later
  never rewrites which past campaigns "count" for either segment.

## Limitations to know about

- **Open tracking is inherently approximate.** Some email clients block or
  preload tracking pixels, which can under- or over-count opens. This is
  labeled directly in the campaign report, not just buried in these docs.
- **Click tracking depends on Resend's own link tracking** — this app
  doesn't run a custom URL shortener or rewrite links itself, per the
  original brief; it only stores what Resend's webhook reports.
- **Sending is still one-at-a-time** with a short delay, sized for
  personal-list volumes and free-tier rate limits, not bulk/marketing-scale
  volume.
- **The webhook requires a reachable public URL** to register with Resend
  — so analytics can't be tested against a purely local dev server unless
  you tunnel it (e.g. with ngrok) and register that URL as the webhook
  endpoint temporarily.

---

## Live masterclass: registration and automatic reminders

The live page (`fineboyproducer.com.ng/live/`) hands every registration to this app. The app
adds the person to your contacts (segment **Live Registrants**), emails a confirmation within
seconds, and then sends reminders before the live, all automatically.

| Email | When |
|---|---|
| "You're in" confirmation | Within seconds of registering |
| "Tomorrow at 8:00 PM WAT" | Thursday 8:00 PM WAT (any time up to before midnight) |
| "Tonight at 8:00 PM WAT" | Friday 7:00 PM WAT (up to 7:30) |
| "We're live now" | Friday 8:00 PM WAT (up to 8:30) |

- The live is every Friday at 8:00 PM WAT. Someone who registers on or after the end of a live is registered for the next Friday. The **server** decides which Friday, not the visitor's device clock.
- Nobody gets the same email twice, even if two runs overlap or something crashes and retries (`live_reminder_log` has one row per person per email). A failed send is retried on the next run, up to 3 times.
- Someone who registers within 15 minutes before a reminder skips it (they just heard from us).
- Every email has an unsubscribe link and the one-click unsubscribe button mail apps show. It stops live reminders only. It does not change the person's status for your campaigns.
- Emails link to the live page, where "Join on Google Meet" appears once you add that week's link to `MEET_URLS` in `live/index.html`. You never have to put the Meet link in the Emailer.

### Setup (once)

1. **Deploy this version** to Render. The two new tables (`live_registrations`, `live_reminder_log`) are created automatically at startup (`sql/02_live_reminders.sql`; running it by hand is optional).
2. **Add `CRON_SECRET`** in Render, Environment: a long random string, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Redeploy/restart. `APP_URL`, `RESEND_API_KEY` and `FROM_EMAIL` must already be set (they are for campaigns).
3. **Turn on the scheduler.** Render's free tier sleeps, so something outside it has to call it every 5 minutes. This repo includes `.github/workflows/live-reminders.yml` for that. In the GitHub repo: Settings, Secrets and variables, Actions, add **`EMAILER_URL`** (your Render address, no trailing slash) and **`CRON_SECRET`** (the same value as step 2). Then Actions tab, "Live reminders", Run workflow, to check it goes green.
   - GitHub can start scheduled runs a few minutes late and pauses them if the repo is untouched for 60 days. The reminder windows above tolerate up to 30 minutes' delay. If you want something stricter, a free cron service (e.g. cron-job.org) calling `POST /api/public/live/cron` with header `x-cron-secret: <CRON_SECRET>` every 5 minutes works the same way.
4. **Connect the page.** In `live/index.html` (site repo), set `EMAILER_URL` in `CONFIG` to your Render address. Push the site. Until this is set, the page works exactly as before and sends nothing to the Emailer.

### Test before the live

```bash
# Rehearsal: lists what a real run would send right now, sends nothing
curl -X POST "https://YOUR-EMAILER.onrender.com/api/public/live/cron?dry_run=1" -H "x-cron-secret: YOUR_CRON_SECRET"
```
Register on the live page with your own email: the confirmation should arrive within a minute (the first request can be slow if Render was asleep), and the person should appear under **Contacts**, segment **Live Registrants**. Click the unsubscribe link in it: it shows a confirm button, and nothing changes until you press it.

### Watching it work

- Who has been sent what: tables `live_reminder_log` (one row per person per email, with any error) and `live_registrations` in Supabase.
- Emails also appear in your Resend dashboard.
- `POST /api/public/live/cron` replies with JSON: how many registrations, how many due, sent, failed, and the first errors.

### Settings (all optional, in Render's environment)

`LIVE_EMAIL_KINDS` (default `confirm,24h,1h,live`; drop any you don't want, e.g. `confirm,1h`), `LIVE_EVENT_NAME`, `LIVE_WEEKDAY`, `LIVE_HOUR_WAT`, `LIVE_DURATION_MIN`, `LIVE_PAGE_URL`, `LIVE_SEGMENT_NAME`, `LIVE_FROM_NAME`, `LIVE_ALLOWED_ORIGINS`. See `.env.example`.

### Limits to know about

- **Resend's free plan allows 100 emails a day.** On the Friday each person gets 2 emails (1h and live), so the free plan covers about 50 registrants; trim with `LIVE_EMAIL_KINDS` or upgrade for the day.
- If the page's hand-off to the Emailer fails (visitor closes the tab while Render is waking), that person is not scheduled. If this app's database is the **same Supabase project** as the live page's `event_registrations` table, it notices and imports them automatically on the next run (`LIVE_SYNC_FROM_SITE_TABLE`). If the projects are different, this safety net does nothing, so check the Resend/`live_registrations` count against the page's Supabase table after the first live.
- WhatsApp is not part of this: the Emailer sends email only.
- The older `Auto-Reminder` Supabase functions were built for the one-off 25 September YouTube live. They are not used by this setup. If their `live-reminders` schedule is still active in Supabase, remove it (`select cron.unschedule('live-reminders');`) so nothing can email people twice.
