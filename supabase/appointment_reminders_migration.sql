alter table appointments
add column if not exists reminder_24h_sent_at timestamptz;
