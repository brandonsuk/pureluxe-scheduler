# PureLuxe Smart Scheduling

Next.js app with:
- Booking widget (`/book`)
- Admin panel (`/admin`)
- Scheduling APIs (`/api/*`)

## Setup

1. Install dependencies
```bash
npm install
```
2. Configure environment
```bash
cp .env.example .env.local
```
3. Apply schema and seed in Supabase SQL editor:
- `supabase/schema.sql`
- `supabase/seed.sql`
- If upgrading an existing database, also run:
- `supabase/google_calendar_migration.sql`
- `supabase/calendar_sync_migration.sql`
- `supabase/open_slots_sync_migration.sql`
- `supabase/calendar_blockers_migration.sql`
- `supabase/appointment_reminders_migration.sql`
- `supabase/abandoned_followups_migration.sql`
4. Run dev server
```bash
npm run dev
```

## API Endpoints

- `POST /api/validate-address`
- `POST /api/available-slots`
- `POST /api/available-dates`
- `POST /api/preferred-slots`
- `POST /api/slot-help-request`
- `POST /api/book`
- `POST /api/cancel`
- `POST /api/lead-progress`
- `POST /api/twilio/inbound-sms`
- `POST /api/resend/inbound-email`
- `GET /api/appointments`
- `GET /api/reminder-check` (cron, bearer auth)
- `GET /api/abandoned-lead-check` (cron, bearer auth)
- `GET /api/calendar-sync-check` (cron, bearer auth)
- `POST /api/calendar-sync-run` (admin-triggered manual sync)
- `GET /api/open-slots-sync-check` (cron/manual bearer auth)
- `POST /api/open-slots-sync-run` (admin-triggered manual sync)
- `GET /api/auth`
- `POST /api/working-hours`
- `GET /api/working-hours`

## Notes

- Route validation is implemented in `lib/scheduler.ts`.
- 24h SMS reminders are sent by `/api/reminder-check`, intended to run every 15 minutes under cron.
- Abandoned-funnel SMS follow-up is sent by `/api/abandoned-lead-check`, intended to run every 15 minutes under cron. Lovable should `POST /api/lead-progress` at key funnel steps; the cron texts leads inactive for 20+ minutes, starting from funnel step 1, unless they have already booked, were disqualified, have already been reminded, or have an invalid phone.
- Distance calculations are TomTom-only (`TOMTOM_API_KEY`, `DISTANCE_PROVIDER=tomtom`).
- Google Calendar integration creates an event on booking and deletes it on cancellation when calendar env vars are set.
- `POST /api/book` accepts optional qualifying fields (`renovation_type`, `wall_type`, `budget`; plus `full_renovation` boolean aliases) and adds them to the Google Calendar event description when provided.
- Calendar drift detection is detect-only: `/api/calendar-sync-check` updates `calendar_sync_state` to `in_sync`, `out_of_sync`, or `missing`.
- Open-slot sync imports Google Calendar events titled `Open slots` into `working_hour_windows` (source `google_open_slots`). Slot generation uses only these synced windows (no fallback to `working_hours`).
- The same sync also imports non-`Open slots` timed Google Calendar events with a valid `location` into `calendar_blockers`, unless they already belong to a scheduler-created appointment. Slot generation treats these blockers like existing appointments for overlap and routing.
- `POST /api/preferred-slots` supports optional `preferred_time` (`HH:mm`) so exact-time preference can influence ranking while drive efficiency remains dominant.
- Twilio inbound SMS webhook supports `CA` (cancel) and `UNDO` (restore) for the sender's next upcoming appointment.
- Resend inbound email webhook supports `CA` in reply body and cancels the sender's next upcoming confirmed appointment.
- Every cancellation sends an admin alert email to `ADMIN_ALERT_EMAIL` (defaults to `contact@pureluxebathrooms.co.uk`).
- Resume links in abandoned-funnel SMS use `FUNNEL_BASE_URL` and the frontend `/resume?session=<lead_session_id>` route.
