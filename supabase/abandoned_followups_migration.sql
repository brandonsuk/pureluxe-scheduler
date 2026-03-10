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
