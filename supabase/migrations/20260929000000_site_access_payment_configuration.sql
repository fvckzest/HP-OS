-- Operational Site identity and non-secret payment configuration. The
-- generated Supabase Data API remains disabled; the app accesses this schema
-- through its private PostgreSQL connection.
create schema if not exists hpos;
revoke all on schema hpos from public;

do $block$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema hpos from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema hpos from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on schema hpos from service_role';
  end if;
end
$block$;

create table hpos.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  fee_terms_status text not null default 'pending_validation'
    check (fee_terms_status = 'pending_validation'),
  created_at timestamptz not null default now()
);

create table hpos.sites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references hpos.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  request_limit_per_minute integer not null default 1200
    check (request_limit_per_minute between 1 and 10000000),
  created_at timestamptz not null default now(),
  unique (id, organization_id)
);

create table hpos.payment_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references hpos.organizations(id) on delete cascade,
  provider text not null check (provider in ('square', 'stripe')),
  environment text not null check (environment in ('test', 'live')),
  account_reference text not null check (char_length(account_reference) between 1 and 500),
  location_reference text check (location_reference is null or char_length(location_reference) between 1 and 500),
  account_eligibility_status text not null default 'pending_validation'
    check (account_eligibility_status = 'pending_validation'),
  created_at timestamptz not null default now(),
  unique (id, organization_id)
);

create table hpos.site_payment_connection_assignments (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null,
  organization_id uuid not null,
  connection_id uuid not null,
  assigned_at timestamptz not null default now(),
  unassigned_at timestamptz,
  foreign key (site_id, organization_id)
    references hpos.sites(id, organization_id) on delete cascade,
  foreign key (connection_id, organization_id)
    references hpos.payment_connections(id, organization_id) on delete cascade,
  check (unassigned_at is null or unassigned_at > assigned_at)
);

create unique index site_payment_one_active_connection_idx
  on hpos.site_payment_connection_assignments (site_id)
  where unassigned_at is null;
create index site_payment_connection_history_idx
  on hpos.site_payment_connection_assignments (site_id, connection_id, assigned_at desc);

create table hpos.site_api_keys (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references hpos.sites(id) on delete cascade,
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index site_api_keys_active_site_idx
  on hpos.site_api_keys (site_id, created_at desc)
  where revoked_at is null;

create table hpos.site_request_windows (
  site_id uuid not null references hpos.sites(id) on delete cascade,
  window_start timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (site_id, window_start)
);

comment on column hpos.organizations.fee_terms_status is
  'Concrete fee values and their configuration model remain pending validation; do not infer or calculate terms from this status.';
comment on column hpos.payment_connections.account_eligibility_status is
  'Provider account eligibility remains pending validation until confirmed for the account and environment.';
comment on table hpos.site_api_keys is
  'Stores SHA-256 hashes of high-entropy Site API keys only. Plaintext keys are returned once by the operator command and never stored.';
comment on table hpos.site_payment_connection_assignments is
  'Assignment history is retained so a Site can read a connection it previously used for an Order.';
