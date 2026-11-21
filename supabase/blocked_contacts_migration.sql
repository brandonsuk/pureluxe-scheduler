-- Contacts blocked from booking (CRM "Block" button, 21 Nov 2026).
-- phone_key = last 10 digits of the phone, email_key = lowercased email ("" when not given).
-- Unblocking sets unblocked_at; rows are kept as history.
CREATE TABLE IF NOT EXISTS public.blocked_contacts (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_key          TEXT        NOT NULL DEFAULT '',
  email_key          TEXT        NOT NULL DEFAULT '',
  client_name        TEXT,
  reason             TEXT,
  airtable_record_id TEXT,
  blocked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unblocked_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS blocked_contacts_phone_active ON public.blocked_contacts (phone_key) WHERE unblocked_at IS NULL;
CREATE INDEX IF NOT EXISTS blocked_contacts_email_active ON public.blocked_contacts (email_key) WHERE unblocked_at IS NULL;

-- Server only (service role). No policies, so the anon key can't read or write it.
ALTER TABLE public.blocked_contacts ENABLE ROW LEVEL SECURITY;
