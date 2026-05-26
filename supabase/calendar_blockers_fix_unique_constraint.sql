-- Fix: the original migration put a global unique constraint on google_event_id,
-- but multi-day calendar events produce one blocker row per day (all sharing the
-- same google_event_id). That caused the entire blocker INSERT to fail whenever
-- Thomas had any multi-day event in his calendar, leaving the table empty and
-- making manually-added appointments invisible to slot validation.
--
-- Run this in the Supabase SQL editor if the calendar_blockers table already exists.

alter table calendar_blockers drop constraint if exists calendar_blockers_google_event_id_key;

create unique index if not exists idx_calendar_blockers_event_date
  on calendar_blockers (google_event_id, date);
