# Follow-up email sequence: runbook

21 emails (see `src/sequence/emails.md`) sell the Blueprint, the Artist Growth Bundle and AGI to people who registered for a live. It runs on the same 5-minute timer as the live reminders (no new scheduler). **It is off until `SEQ_ENABLED=true`.**

## How it behaves
- Day 0 is the Friday of the person's first live. Day 1 is the next day. Lead emails go out from 8:00 AM WAT (`SEQ_SEND_HOUR_WAT`) and may still go for 30 hours after that (`SEQ_LATE_HOURS`), then are skipped, never sent at a silly time.
- A person only joins the sequence if its first email (B1) actually went out. Anyone whose B1 window passed never gets a mid-story email.
- A recorded purchase removes the person from the sales emails (B, U, A) and starts that product's buyer emails (C1 to C3 for the Blueprint, C4 for the bundle). The 3 long-tail emails (N1 to N3) still go to buyers. An AGI buyer gets no buyer email.
- Unsubscribing (the link in every email) unsubscribes the contact from everything on this list. Opening the link does nothing; the button does it.
- Each email goes out once per person (`sequence_log` has a unique key), and failures are retried 3 times.
- A daily cap (`SEQ_DAILY_CAP`, default 80) counts these emails plus live reminders, because Resend's cap counts all of them. Emails over the cap wait for the next run, until their window closes.

## Settings (Render, Environment)
| Name | Meaning |
| --- | --- |
| `SEQ_ENABLED` | `true` to send. Anything else sends nothing. |
| `SEQ_REPLY_TO` | An inbox you read. The emails ask people to reply. |
| `SEQ_TEST_EMAIL` | Your own address, the only one the test sender will mail. |
| `SEQ_ONLY_EMAIL` | Rehearsal: when set, only this address receives the sequence. |
| `SEQ_DAILY_CAP` | Default 80. Raise it after upgrading Resend. |
| `PAYSTACK_SECRET_KEY` | Lets Paystack tell the Emailer who has paid (below). |
| `SEQ_PRODUCT_AMOUNTS` | Optional. Default `blueprint:35000,bundle:27750,agi:99700` (naira). |

## Check each email on your phone first
POST to `/api/public/live/sequence/test?step=B1` (header `x-cron-secret`) sends that one email to `SEQ_TEST_EMAIL` with `[TEST]` in the subject. Steps: B1 to B6, U1 to U4, A1 to A4, N1 to N3, C1 to C4.

## Record purchases automatically (Paystack)
1. Add your Paystack **secret** key as `PAYSTACK_SECRET_KEY` in Render (never in GitHub).
2. In Paystack, Settings, API Keys & Webhooks, set the **Live webhook URL** to `https://emailer-0w2b.onrender.com/api/webhooks/paystack`.
3. The amount decides the product (35,000, 27,750 or 99,700 naira). Other amounts, such as the Release Checklist, are ignored.

## Record a purchase by hand (Supabase SQL editor, the Emailer's project)
```sql
insert into sequence_purchases (email, product) values ('buyer@example.com', 'blueprint')   -- or 'bundle' or 'agi'
on conflict do nothing;
```
Also make sure the person is in `contacts` (they are if they registered for a live).

## Look at it
`GET /api/public/live/sequence/status` (header `x-cron-secret`) shows whether it is on, counts per email, failures (addresses masked) and warnings. The scheduler's own response also has a `sequence` section.

## Stop it
Set `SEQ_ENABLED` to anything but `true` and restart. Nothing else sends.
