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
- `GET /api/auth`
- `POST /api/working-hours`
- `GET /api/working-hours`

## Notes

- Route validation is implemented in `lib/scheduler.ts`.
- 24h and 2h reminders are stubbed in `lib/notifications.ts` for cron/queue integration.
- Distance calculations default to TomTom (`TOMTOM_API_KEY`, `DISTANCE_PROVIDER=tomtom`) with Google fallback.
- Google Calendar integration creates an event on booking and deletes it on cancellation when calendar env vars are set.
