alter table appointments add column if not exists calendar_last_start timestamptz;
alter table appointments add column if not exists calendar_last_end timestamptz;
alter table appointments add column if not exists calendar_last_status text;
alter table appointments add column if not exists calendar_sync_state text not null default 'in_sync';
alter table appointments add column if not exists calendar_last_checked_at timestamptz;
