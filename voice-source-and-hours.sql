-- Run once in Supabase SQL Editor. Adds: (1) a way to tell voice customers
-- apart from chat customers in the dashboard, (2) business-hours + a manual
-- kill switch for the voice line, checked before a call even connects.

begin;

alter table customers add column if not exists source text default 'chat';
-- Existing rows default to 'chat' (accurate — voice didn't exist until now).
-- The voice webhook explicitly sets 'voice' on new rows it creates.

alter table tenants add column if not exists voice_enabled boolean default true;
alter table tenants add column if not exists voice_open_hour integer default 0;   -- 0-23, local time
alter table tenants add column if not exists voice_close_hour integer default 24; -- 0-24 (24 = open all day)
alter table tenants add column if not exists voice_timezone text default 'America/Edmonton';

commit;
