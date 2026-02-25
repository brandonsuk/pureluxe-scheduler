create extension if not exists "pgcrypto";

create table if not exists working_hours (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  start_time time not null,
  end_time time not null,
  is_available boolean not null default true
);

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
