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
4. Run dev server
```bash
npm run dev
```

## API Endpoints

- `POST /api/validate-address`
- `POST /api/available-slots`
- `POST /api/preferred-slots`
- `POST /api/slot-help-request`
- `POST /api/book`
- `POST /api/cancel`
- `GET /api/appointments`
- `GET /api/calendar-sync-check` (cron, bearer auth)
- `POST /api/calendar-sync-run` (admin-triggered manual sync)
- `GET /api/open-slots-sync-check` (cron/manual bearer auth)
- `POST /api/open-slots-sync-run` (admin-triggered manual sync)
- `GET /api/auth`
- `POST /api/working-hours`
- `GET /api/working-hours`

## Notes

- Route validation is implemented in `lib/scheduler.ts`.
- 24h and 2h reminders are stubbed in `lib/notifications.ts` for cron/queue integration.
- Distance calculations are TomTom-only (`TOMTOM_API_KEY`, `DISTANCE_PROVIDER=tomtom`).
- Google Calendar integration creates an event on booking and deletes it on cancellation when calendar env vars are set.
- Calendar drift detection is detect-only: `/api/calendar-sync-check` updates `calendar_sync_state` to `in_sync`, `out_of_sync`, or `missing`.
- Open-slot sync imports Google Calendar events titled `Open slots` into `working_hour_windows` (source `google_open_slots`). Slot generation uses only these synced windows (no fallback to `working_hours`).
