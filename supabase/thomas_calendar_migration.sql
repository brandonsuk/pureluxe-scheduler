-- Add thomas_event_id to track the corresponding event on Thomas's PureLuxe calendar
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS thomas_event_id TEXT;
