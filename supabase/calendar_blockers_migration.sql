create table if not exists calendar_blockers (
  id uuid primary key default gen_random_uuid(),
  google_event_id text not null unique,
  summary text not null,
  address text not null,
  lat double precision not null,
  lng double precision not null,
  date date not null,
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_calendar_blockers_date
  on calendar_blockers (date, start_time);
