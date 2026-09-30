-- Store the payment connection selected for each new Order. Connection changes
-- then apply only to future Orders, while existing Orders keep their original
-- provider account and environment.
alter table hpos.orders
  add column payment_connection_id uuid;

alter table hpos.orders
  add constraint orders_payment_connection_fk
    foreign key (payment_connection_id)
    references hpos.payment_connections(id)
    on delete restrict;

comment on column hpos.orders.payment_connection_id is
  'Payment connection selected when the Order was created; historical Orders never switch providers.';

-- Eligibility is verified outside HP-OS because provider credentials and
-- account calls stay on the Site backend. Operators record the verified state
-- and a non-secret evidence reference here.
alter table hpos.payment_connections
  drop constraint payment_connections_account_eligibility_status_check,
  add constraint payment_connections_account_eligibility_status_check
    check (account_eligibility_status in ('pending_validation', 'eligible', 'ineligible')),
  add column platform_fee_eligibility_status text not null default 'pending_validation'
    check (platform_fee_eligibility_status in ('pending_validation', 'eligible', 'ineligible')),
  add column eligibility_validated_at timestamptz,
  add column eligibility_evidence_reference text,
  add constraint payment_connections_eligibility_evidence_check check (
    (account_eligibility_status = 'pending_validation'
      and platform_fee_eligibility_status = 'pending_validation'
      and eligibility_validated_at is null
      and eligibility_evidence_reference is null)
    or (account_eligibility_status <> 'pending_validation'
      and platform_fee_eligibility_status <> 'pending_validation'
      and eligibility_validated_at is not null
      and eligibility_evidence_reference ~ '^ref:[A-Za-z0-9][A-Za-z0-9._:-]{0,245}$')
  );

comment on column hpos.payment_connections.account_eligibility_status is
  'Account access and seller eligibility verified by the Site backend for this provider connection.';
comment on column hpos.payment_connections.platform_fee_eligibility_status is
  'Provider permission and account eligibility to collect the configured platform fee; does not prove fee settlement.';
comment on column hpos.payment_connections.eligibility_evidence_reference is
  'Non-secret ref: alias identifying external eligibility evidence; never store provider tokens or payment credentials.';

create table hpos.payment_attempts (
  id uuid primary key,
  site_id uuid not null,
  order_id uuid not null,
  connection_id uuid not null,
  provider text not null check (provider in ('square', 'stripe')),
  environment text not null check (environment in ('test', 'live')),
  account_reference text not null check (account_reference ~ '^ref:[A-Za-z0-9][A-Za-z0-9._:-]{0,245}$'),
  location_reference text check (location_reference is null or location_reference ~ '^ref:[A-Za-z0-9][A-Za-z0-9._:-]{0,245}$'),
  account_eligibility_status text not null check (account_eligibility_status = 'eligible'),
  platform_fee_eligibility_status text not null check (
    platform_fee_eligibility_status in ('eligible', 'ineligible')
    and (environment = 'test' or platform_fee_eligibility_status = 'eligible')
  ),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  total_amount bigint not null check (total_amount between 1 and 9007199254740991),
  platform_fee_amount bigint not null check (platform_fee_amount between 0 and 9007199254740991),
  provider_mapping jsonb,
  provider_checkout_reference text,
  provider_payment_reference text,
  last_outcome text check (last_outcome is null or last_outcome in ('not_started', 'processing', 'paid', 'failed', 'canceled', 'unknown')),
  provider_can_take_payment boolean,
  status text not null default 'creating' check (status in ('creating', 'open', 'closed', 'requires_verification')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, site_id),
  foreign key (order_id, site_id) references hpos.orders(id, site_id) on delete restrict,
  foreign key (connection_id) references hpos.payment_connections(id) on delete restrict,
  check (provider_mapping is null or jsonb_typeof(provider_mapping) = 'object'),
  check (provider_checkout_reference is null or char_length(provider_checkout_reference) between 1 and 500),
  check (provider_payment_reference is null or char_length(provider_payment_reference) between 1 and 500),
  check (status <> 'open' or (provider_checkout_reference is not null and provider_can_take_payment = true)),
  check (status <> 'closed' or provider_can_take_payment = false)
);

create unique index payment_attempts_one_payment_capable_order_idx
  on hpos.payment_attempts (order_id)
  where status in ('creating', 'open', 'requires_verification');

create unique index payment_attempts_provider_checkout_reference_idx
  on hpos.payment_attempts (connection_id, provider_checkout_reference)
  where provider_checkout_reference is not null;

create index payment_attempts_site_recent_idx
  on hpos.payment_attempts (site_id, created_at desc, id);

create table hpos.payment_attempt_closure_reports (
  id uuid primary key,
  site_id uuid not null,
  attempt_id uuid not null,
  connection_id uuid not null,
  source_reference text not null check (char_length(source_reference) between 1 and 500),
  provider_checkout_reference text not null check (char_length(provider_checkout_reference) between 1 and 500),
  observed_at timestamptz not null,
  payment_outcome text not null check (payment_outcome in ('not_started', 'failed', 'canceled')),
  created_at timestamptz not null default clock_timestamp(),
  constraint payment_attempt_closure_reports_source_key unique (site_id, connection_id, source_reference),
  foreign key (attempt_id, site_id) references hpos.payment_attempts(id, site_id) on delete restrict,
  foreign key (connection_id) references hpos.payment_connections(id) on delete restrict
);

comment on table hpos.payment_attempts is
  'Site-owned provider setup attempts created before provider calls; unresolved attempts keep their Order Reservation held.';
comment on table hpos.payment_attempt_closure_reports is
  'Provider-verified closure evidence used to release an unpaid Reservation or permit a safe replacement attempt.';
