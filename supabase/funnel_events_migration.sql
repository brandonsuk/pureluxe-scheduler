-- Append-only funnel analytics log (applied 11 Nov 2026). Written only by /api/funnel-event.
-- Nothing else reads it. RLS on with no policies: service role only.
CREATE TABLE IF NOT EXISTS public.funnel_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lead_session_id TEXT NOT NULL,
  event TEXT NOT NULL,
  path TEXT,
  variants JSONB NOT NULL DEFAULT '{}'::jsonb,
  device TEXT,
  viewport_w INTEGER,
  utm_campaign TEXT,
  ad_id TEXT,
  is_test BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS funnel_events_session_idx ON public.funnel_events (lead_session_id, created_at);
CREATE INDEX IF NOT EXISTS funnel_events_created_idx ON public.funnel_events (created_at);
ALTER TABLE public.funnel_events ENABLE ROW LEVEL SECURITY;
