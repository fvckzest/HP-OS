-- Durable notification work is owned by HP-OS. Site workers claim it and
-- perform credential-dependent delivery outside this database transaction.
create table hpos.notification_claims (
  id uuid primary key,
  site_id uuid not null references hpos.sites(id) on delete cascade,
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  created_actor_type text not null check (created_actor_type in ('user', 'system')),
  created_actor_reference text not null check (created_actor_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  renewed_at timestamptz,
  renewed_actor_type text check (renewed_actor_type is null or renewed_actor_type in ('user', 'system')),
  renewed_actor_reference text check (renewed_actor_reference is null or renewed_actor_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  closed_at timestamptz,
  unique (id, site_id),
  check (
    (renewed_at is null and renewed_actor_type is null and renewed_actor_reference is null)
    or (renewed_at is not null and renewed_actor_type is not null and renewed_actor_reference is not null)
  )
);

create table hpos.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references hpos.sites(id) on delete cascade,
  kind text not null check (kind in (
    'access_approved', 'tickets_ready', 'order_recovery',
    'event_changed', 'event_canceled', 'wallet_update'
  )),
  status text not null default 'pending'
    check (status in ('pending', 'failed', 'completed')),
  event_id uuid,
  order_id uuid,
  access_request_id uuid,
  ticket_id uuid,
  is_superseded boolean not null default false,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  requires_verification boolean not null default false,
  provider_message_reference text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  claim_id uuid,
  lease_fence bigint not null default 0 check (lease_fence >= 0),
  unique (id, site_id),
  foreign key (claim_id, site_id)
    references hpos.notification_claims(id, site_id),
  check (
    (kind = 'access_approved' and event_id is not null and access_request_id is not null and order_id is null and ticket_id is null)
    or (kind = 'tickets_ready' and event_id is not null and order_id is not null and access_request_id is null and ticket_id is null)
    or (kind = 'order_recovery' and event_id is null and order_id is null and access_request_id is null and ticket_id is null)
    or (kind in ('event_changed', 'event_canceled') and event_id is not null and order_id is not null and access_request_id is null and ticket_id is null)
    or (kind = 'wallet_update' and event_id is null and order_id is null and access_request_id is null and ticket_id is not null)
  )
);

create index notification_jobs_site_created_idx
  on hpos.notification_jobs (site_id, created_at desc, id desc);
create index notification_jobs_due_idx
  on hpos.notification_jobs (site_id, available_at, created_at, id)
  where status = 'pending' and is_superseded = false;
create index notification_jobs_event_idx
  on hpos.notification_jobs (site_id, event_id, created_at desc, id desc)
  where event_id is not null;
create index notification_jobs_order_idx
  on hpos.notification_jobs (site_id, order_id, created_at desc, id desc)
  where order_id is not null;

create table hpos.notification_dispatch_attempts (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null,
  job_id uuid not null,
  attempt_number integer not null check (attempt_number > 0),
  claim_id uuid not null,
  lease_fence bigint not null check (lease_fence > 0),
  outcome text not null check (outcome in ('completed', 'failed', 'unknown')),
  provider_message_reference text,
  observed_at timestamptz not null,
  error_code text,
  actor_type text not null check (actor_type in ('user', 'system')),
  actor_reference text not null check (actor_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (job_id, site_id)
    references hpos.notification_jobs(id, site_id) on delete cascade,
  foreign key (claim_id, site_id)
    references hpos.notification_claims(id, site_id) on delete cascade,
  unique (job_id, attempt_number),
  unique (site_id, job_id, provider_message_reference)
);

create unique index notification_dispatch_provider_reference_idx
  on hpos.notification_dispatch_attempts (site_id, provider_message_reference)
  where provider_message_reference is not null;

create table hpos.notification_delivery_events (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null,
  job_id uuid not null,
  provider_message_reference text not null,
  provider_event_reference text not null,
  outcome text not null check (outcome in ('delivered', 'failed')),
  observed_at timestamptz not null,
  actor_type text not null check (actor_type in ('user', 'system')),
  actor_reference text not null check (actor_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (site_id, job_id, provider_message_reference)
    references hpos.notification_dispatch_attempts(site_id, job_id, provider_message_reference) on delete cascade,
  unique (site_id, provider_event_reference)
);

create index notification_delivery_events_job_time_idx
  on hpos.notification_delivery_events (site_id, job_id, observed_at desc, id desc);

create table hpos.notification_idempotency_records (
  site_id uuid not null references hpos.sites(id) on delete cascade,
  idempotency_key uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  response_status integer,
  response_data jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (site_id, idempotency_key),
  check (
    (response_status is null and response_data is null and completed_at is null)
    or (response_status between 200 and 299 and response_data is not null and completed_at is not null)
  )
);

-- Keep only the latest scheduler summary for operational status. Durable
-- jobs remain the authoritative work records.
create table hpos.processing_state (
  singleton boolean primary key default true check (singleton),
  run_id uuid,
  trigger text check (trigger is null or trigger in ('local_scheduler', 'vercel_cron')),
  started_at timestamptz,
  finished_at timestamptz,
  result jsonb,
  check (
    (run_id is null and trigger is null and started_at is null and finished_at is null and result is null)
    or (run_id is not null and trigger is not null and started_at is not null)
  )
);

insert into hpos.processing_state (singleton) values (true)
on conflict (singleton) do nothing;

comment on table hpos.notification_jobs is
  'Durable Site-scoped delivery work. Producer operations insert in the same transaction as their triggering business change.';
comment on column hpos.notification_jobs.lease_fence is
  'Monotonically advances when a lease is replaced or recovered so stale workers cannot report a fresh outcome.';
comment on table hpos.notification_idempotency_records is
  'Notification-operation idempotency fingerprints and replayable results; used keys remain after the seven-day response replay window.';
comment on table hpos.processing_state is
  'Latest HP-OS processing observation only; the notification_jobs table remains the durable queue authority.';
