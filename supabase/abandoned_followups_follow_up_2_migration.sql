-- Add follow_up_2_sent_at column to abandoned_followups table
-- Tracks when the second follow-up (sent 24h after the first) was dispatched

ALTER TABLE abandoned_followups
  ADD COLUMN IF NOT EXISTS follow_up_2_sent_at TIMESTAMPTZ DEFAULT NULL;
