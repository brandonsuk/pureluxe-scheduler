create table if not exists working_hour_windows (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  start_time time not null,
  end_time time not null,
  is_available boolean not null default true,
  source text not null default 'manual' check (source in ('manual', 'google_open_slots')),
  google_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_working_hour_windows_unique
  on working_hour_windows (date, start_time, end_time, source);
create index if not exists idx_working_hour_windows_date on working_hour_windows (date);
