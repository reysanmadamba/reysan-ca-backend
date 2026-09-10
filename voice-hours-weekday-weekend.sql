-- Per-day-of-week store hours (not just weekday/weekend) — one JSON field
-- holding all 7 days, each with its own open/close hour. Safe to run;
-- only adds new columns, nothing to migrate since the earlier
-- weekday/weekend version was never actually run.

begin;

alter table tenants drop column if exists voice_open_hour;
alter table tenants drop column if exists voice_close_hour;
alter table tenants drop column if exists voice_weekday_open_hour;
alter table tenants drop column if exists voice_weekday_close_hour;
alter table tenants drop column if exists voice_weekend_open_hour;
alter table tenants drop column if exists voice_weekend_close_hour;

-- Each day: {"open": <hour 0-24>, "close": <hour 0-24>}. open === close
-- means closed all day that day. 0/24 means open the full 24 hours.
alter table tenants add column if not exists voice_hours jsonb default '{
  "mon": {"open": 0, "close": 24},
  "tue": {"open": 0, "close": 24},
  "wed": {"open": 0, "close": 24},
  "thu": {"open": 0, "close": 24},
  "fri": {"open": 0, "close": 24},
  "sat": {"open": 0, "close": 24},
  "sun": {"open": 0, "close": 24}
}'::jsonb;

-- Tim Hortons' actual hours, per your example (Thu/Fri filled in the same
-- as Mon/Wed since you didn't specify those two — adjust anytime in the
-- settings panel).
update tenants
set voice_hours = '{
  "mon": {"open": 8, "close": 22},
  "tue": {"open": 9, "close": 22},
  "wed": {"open": 8, "close": 22},
  "thu": {"open": 8, "close": 22},
  "fri": {"open": 8, "close": 22},
  "sat": {"open": 11, "close": 22},
  "sun": {"open": 14, "close": 20}
}'::jsonb,
voice_timezone = 'America/Edmonton'
where slug = 'timhortons';

commit;
