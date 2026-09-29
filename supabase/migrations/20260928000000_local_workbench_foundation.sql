-- Local-only diagnostic history. This schema is not exposed through Supabase's
-- generated Data API; the application connects to PostgreSQL directly.
create schema if not exists workbench;
revoke all on schema workbench from public;

do $block$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema workbench from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema workbench from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on schema workbench from service_role';
  end if;
end
$block$;

create table if not exists workbench.local_environment (
  singleton boolean primary key default true check (singleton),
  environment text not null check (environment = 'local-test'),
  created_at timestamptz not null default now()
);

insert into workbench.local_environment (singleton, environment)
values (true, 'local-test')
on conflict (singleton) do update set environment = excluded.environment;

create table if not exists workbench.call_history (
  id uuid primary key default gen_random_uuid(),
  recorded_at timestamptz not null default now(),
  source text not null check (source in ('manual', 'guided', 'local-lmnl')),
  attempt integer not null default 1 check (attempt > 0),
  method text not null,
  route text not null,
  request_snapshot jsonb not null,
  expectation_snapshot jsonb,
  result_state text not null check (result_state in ('not_checked', 'passed', 'failed', 'unknown')),
  outcome_state text not null check (outcome_state in ('response_received', 'outcome_unknown')),
  status_code integer check (status_code between 100 and 599),
  response_snapshot jsonb,
  error_code text,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  capture_state text not null check (capture_state in ('stored', 'incomplete')),
  environment text not null default 'local',
  dataset_label text not null default 'local-foundation-empty',
  revision text not null default 'unknown'
);

create index if not exists call_history_recorded_at_idx
  on workbench.call_history (recorded_at desc, id desc);
