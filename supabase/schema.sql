create extension if not exists "pgcrypto";

create table if not exists working_hours (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  start_time time not null,
  end_time time not null,
  is_available boolean not null default true
);

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

create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  start_time time not null,
  end_time time not null,
  duration_mins integer not null,
  client_name text not null,
  client_phone text not null,
  client_email text not null,
  address text not null,
  lat double precision not null,
  lng double precision not null,
  google_event_id text,
  reminder_24h_sent_at timestamptz,
  calendar_last_start timestamptz,
  calendar_last_end timestamptz,
  calendar_last_status text,
  calendar_sync_state text not null default 'in_sync',
  calendar_last_checked_at timestamptz,
  readiness_level text not null check (readiness_level in ('ready', 'partial', 'unsure')),
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled', 'completed')),
  created_at timestamptz not null default now()
);

create index if not exists idx_appointments_date_status on appointments(date, status);

create table if not exists service_area (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  geojson jsonb not null
);

create table if not exists settings (
  key text primary key,
  value text not null
);

create table if not exists abandoned_followups (
  lead_session_id text primary key,
  submission_id text,
  client_name text not null,
  client_phone text not null,
  client_email text not null,
  postcode text not null,
  current_step integer not null default 1,
  last_activity_at timestamptz not null,
  is_disqualified boolean not null default false,
  reminder_sent_at timestamptz,
  suppressed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_abandoned_followups_last_activity
  on abandoned_followups (last_activity_at);
