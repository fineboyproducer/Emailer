# Live reminders: runbook

How the pieces fit, what each needs, how to tell it is working, and how to back out.

## Flow (as implemented)

1. Visitor submits the form on `fineboyproducer.com.ng/live/`.
2. The page saves the registration to the **website's** Supabase table (`event_registrations`). If that fails, the visitor sees an error and nothing else happens.
3. The page then sends the registration to the Emailer in the background (`POST /api/public/live/register`), retrying for about a minute. The visitor's success screen does **not** wait for this.
4. The Emailer validates it, and in one database transaction saves the contact, the segment link and a `live_registrations` row in **its own** Supabase project. Only after that commits does it answer `ok`. A repeat of the same request (same email, same Friday) changes nothing and sends nothing twice.
5. After answering, the Emailer sends the confirmation. If that fails, the next scheduled run retries it.
6. GitHub Actions calls `POST /api/public/live/cron` every 5 minutes (this also wakes a sleeping Render service). Each run sends whatever reminders are due. Each (person, reminder) is claimed in `live_reminder_log` before sending, so repeated or overlapping runs cannot double-send.
7. Resend delivers. Delivery, bounce and open events arrive at `/api/webhooks/resend`.

**Known gap:** if the Emailer is unreachable for the whole retry window and the visitor leaves, the registration exists on the website but never reaches the Emailer, and that person gets no reminders. Nothing detects this yet. Close it with a server-side outbox on the website's Supabase project (a database webhook with a retrying sweep). Until then, compare counts after each live (below).

## Environment variables

**Emailer (Render)**: all must be set; the first group already existed for campaigns.

| Variable | Purpose |
|---|---|
| `SUPABASE_DB_URL` | the Emailer's own Supabase Postgres (pooler, port 6543) |
| `RESEND_API_KEY`, `FROM_EMAIL`, `FROM_NAME` | sending |
| `RESEND_WEBHOOK_SECRET` | delivery/bounce events |
| `ADMIN_PASSWORD`, `SESSION_SECRET` | admin login |
| `APP_URL` | public Render URL; used to build unsubscribe links |
| **`CRON_SECRET`** (new) | protects the scheduler endpoint; must equal the GitHub secret |

Optional: `LIVE_EMAIL_KINDS`, `LIVE_EVENT_NAME`, `LIVE_WEEKDAY`, `LIVE_HOUR_WAT`, `LIVE_DURATION_MIN`, `LIVE_PAGE_URL`, `LIVE_SEGMENT_NAME`, `LIVE_FROM_NAME`, `LIVE_ALLOWED_ORIGINS`.

**GitHub (Emailer repo, Actions secrets)**: `EMAILER_URL` (Render URL, no trailing slash), `CRON_SECRET`.

**Website**: no secrets. `CONFIG.EMAILER_URL` in `live/index.html` is a public address only. The Supabase publishable key already there is designed to be public.

## Database

Website project: unchanged by this work (needs `event_registrations` with its existing columns, including `event_date`).

Emailer project: `sql/02_live_reminders.sql` (idempotent; also runs automatically at startup) creates `live_registrations` and `live_reminder_log`. It references the existing `contacts` table. Nothing is altered or dropped.

## Is it working? (run in the Emailer's Supabase SQL editor)

```sql
-- registrations per Friday
select event_date, count(*) from live_registrations group by 1 order by 1 desc;

-- what has been sent / is failing
select kind, status, count(*) from live_reminder_log group by 1, 2 order by 1, 2;

-- failures with the reason
select r.email, l.kind, l.attempts, l.error, l.updated_at
from live_reminder_log l join live_registrations r on r.id = l.registration_id
where l.status = 'failed' order by l.updated_at desc;

-- confirmations that never went out
select r.email, r.registered_at from live_registrations r
where not exists (select 1 from live_reminder_log l where l.registration_id = r.id and l.kind = 'confirm' and l.status = 'sent')
order by r.registered_at desc;
```

After each live, compare `count(*)` of `live_registrations` for that Friday with the row count in the website's `event_registrations` for the same `event_date`. A difference means registrations missed the hand-off.

Also check: GitHub Actions tab (green runs every 5 minutes), Resend dashboard (delivered / bounced), Render logs (lines starting `[live]`).

## When something goes wrong

- **Render is down or slow:** registrations still save on the website. The page retries the hand-off for about a minute. Restart the service in Render, then compare counts and re-add anyone missing (below).
- **Resend rejects a message:** the row in `live_reminder_log` shows `failed` with the error, and it retries up to 3 times (5 minutes apart). Typical causes: unverified sender domain, daily limit reached, bad address.
- **A person is missing from the Emailer:** add them with `POST /api/public/live/register` using their saved details (safe to repeat), or add them in the admin Contacts page and insert a `live_registrations` row.
- **A reminder was missed:** reminders have windows (24h: Thursday 8:00 PM to 11:50 PM WAT; 1h: 7:00 to 7:30 PM; live: 8:00 to 8:30 PM). Outside its window a reminder is intentionally skipped, not sent late. If a window was missed because the scheduler was down, send that reminder manually from the admin Create Email page to the Live Registrants segment.
- **GitHub Actions stopped:** schedules pause after 60 days without repository activity. Re-enable in the Actions tab, or use any cron service to POST the endpoint with the `x-cron-secret` header.

## Roll back

1. Stop new hand-offs: set `EMAILER_URL` back to `''` in `live/index.html` and push. The page returns to exactly its previous behavior.
2. Stop the scheduler: disable the "Live reminders" workflow in the Actions tab (or remove `CRON_SECRET`; the endpoint then refuses every call).
3. Revert the Emailer: in Render, redeploy the previous successful deploy. The new tables are additive and can stay; nothing else reads them.
