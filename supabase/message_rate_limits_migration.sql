-- Rate limiting table for outbound SMS and email
-- key format:
--   "sms:recipient:+447..."   → per-phone lifetime SMS count
--   "email:recipient:foo@..."  → per-email lifetime email count
--   "sms:day:2026-04-07"       → global daily SMS count
--   "email:day:2026-04-07"     → global daily email count

CREATE TABLE IF NOT EXISTS message_rate_limits (
  key        TEXT        PRIMARY KEY,
  count      INTEGER     NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
