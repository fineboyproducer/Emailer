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
