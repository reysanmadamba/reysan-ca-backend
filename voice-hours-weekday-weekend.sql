-- Replaces the single open/close pair with separate weekday/weekend hours.
-- Safe to run — backfills the new columns from the old ones (which were
-- still at their untouched defaults) before dropping them.

begin;

alter table tenants add column if not exists voice_weekday_open_hour integer default 0;
alter table tenants add column if not exists voice_weekday_close_hour integer default 24;
alter table tenants add column if not exists voice_weekend_open_hour integer default 0;
alter table tenants add column if not exists voice_weekend_close_hour integer default 24;

alter table tenants drop column if exists voice_open_hour;
alter table tenants drop column if exists voice_close_hour;

-- Tim Hortons: 8am-8pm Mountain Time, every day for now (adjust the weekend
-- values later if weekends end up different).
update tenants
set voice_weekday_open_hour = 8, voice_weekday_close_hour = 20,
    voice_weekend_open_hour = 8, voice_weekend_close_hour = 20,
    voice_timezone = 'America/Edmonton'
where slug = 'timhortons';

commit;
