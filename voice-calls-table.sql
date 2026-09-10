-- Voice call minute tracking: run this once in the Supabase SQL Editor.
-- Safe to review first — only adds a new table and one new tenant column,
-- doesn't touch existing data.

begin;

create table if not exists voice_calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  call_id text unique,
  phone text,
  duration_seconds numeric default 0,
  cost_usd numeric default 0,
  ended_reason text,
  recording_url text,
  transcript text,
  created_at timestamptz default now()
);

create index if not exists voice_calls_tenant_created_idx on voice_calls (tenant_id, created_at);

-- Per-tenant cap in minutes, so it's adjustable later without a code change
-- (matches the "admin-configurable" plan from earlier) — 300 as the default
-- you asked for right now.
alter table tenants add column if not exists voice_minutes_cap integer default 300;

commit;
