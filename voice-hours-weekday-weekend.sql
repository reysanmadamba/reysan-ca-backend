-- Store hours apply to BOTH voice and chat, so naming it "store_hours"
-- instead of "voice_hours". Safe to run regardless of whether you ran an
-- earlier version of this file.

begin;

alter table tenants drop column if exists voice_open_hour;
alter table tenants drop column if exists voice_close_hour;
alter table tenants drop column if exists voice_weekday_open_hour;
alter table tenants drop column if exists voice_weekday_close_hour;
alter table tenants drop column if exists voice_weekend_open_hour;
alter table tenants drop column if exists voice_weekend_close_hour;
alter table tenants drop column if exists voice_hours;
alter table tenants drop column if exists voice_timezone;

alter table tenants add column if not exists store_timezone text default 'America/Edmonton';
alter table tenants add column if not exists store_hours jsonb default '{
  "mon": {"open": 0, "close": 24},
  "tue": {"open": 0, "close": 24},
  "wed": {"open": 0, "close": 24},
  "thu": {"open": 0, "close": 24},
  "fri": {"open": 0, "close": 24},
  "sat": {"open": 0, "close": 24},
  "sun": {"open": 0, "close": 24}
}'::jsonb;

commit;
