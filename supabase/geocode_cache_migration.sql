-- Cache geocode result per abandoned lead so the cron never re-geocodes a
-- postcode it has already resolved.
-- NULL  = not yet geocoded
-- true  = out of service area (suppress SMS)
-- false = within service area (eligible for SMS)
alter table abandoned_followups
  add column if not exists geocoded_out_of_area boolean;
