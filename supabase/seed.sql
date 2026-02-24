insert into settings (key, value)
values
  ('home_base_lat', '55.7956'),
  ('home_base_lng', '-3.7939'),
  ('max_drive_mins', '40'),
  ('buffer_mins', '0')
on conflict (key) do update set value = excluded.value;

insert into service_area (name, geojson)
values (
  'PureLuxe Glasgow-Edinburgh Corridor',
  '{
    "type": "Polygon",
    "coordinates": [[
      [-4.3809653, 55.8747443],
      [-4.389205, 55.7667354],
      [-4.2656089, 55.7420056],
      [-4.0129233, 55.6816608],
      [-3.7629843, 55.6955948],
      [-3.5281516, 55.767508],
      [-3.2891989, 55.8739739],
      [-3.2795859, 55.9470965],
      [-3.3798362, 55.9932081],
      [-3.5707236, 56.0308252],
      [-3.6490012, 56.0177785],
      [-3.8192893, 56.0760707],
      [-4.3809653, 55.8747443]
    ]]
  }'::jsonb
)
on conflict do nothing;

with dates as (
  select generate_series(current_date, current_date + interval '60 day', interval '1 day')::date as day
)
insert into working_hours (date, start_time, end_time, is_available)
select
  day,
  '09:00'::time,
  '17:00'::time,
  case when extract(isodow from day) between 2 and 6 then true else false end
from dates
on conflict (date) do update
set
  start_time = excluded.start_time,
  end_time = excluded.end_time,
  is_available = excluded.is_available;
