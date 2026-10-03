-- Store one current provider refund identity and every verified observation.
-- A completed refund changes Order eligibility; non-completed observations do not.
create table hpos.refunds (
  id uuid primary key,
  site_id uuid not null,
  order_id uuid not null,
  attempt_id uuid not null,
  connection_id uuid not null,
  provider text not null check (provider in ('square', 'stripe')),
  environment text not null check (environment in ('test', 'live')),
  account_reference text not null check (account_reference ~ '^ref:[A-Za-z0-9][A-Za-z0-9._:-]{0,245}$'),
  provider_payment_reference text not null check (char_length(provider_payment_reference) between 1 and 500),
  provider_refund_reference text not null check (char_length(provider_refund_reference) between 1 and 500),
  outcome text not null check (outcome in ('processing', 'completed', 'failed', 'unknown')),
  amount bigint not null check (amount between 1 and 9007199254740991),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  observed_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, site_id),
  unique (provider, environment, account_reference, provider_refund_reference),
  foreign key (order_id, site_id) references hpos.orders(id, site_id) on delete restrict,
  foreign key (attempt_id, site_id) references hpos.payment_attempts(id, site_id) on delete restrict,
  foreign key (connection_id) references hpos.payment_connections(id) on delete restrict
);

create index refunds_site_order_observed_idx
  on hpos.refunds (site_id, order_id, observed_at desc, id desc);

comment on table hpos.refunds is
  'Current verified provider refund identity; uniqueness follows provider, environment, account, and refund reference across historical payment connections.';

create table hpos.refund_reports (
  id uuid primary key,
  site_id uuid not null,
  order_id uuid not null,
  attempt_id uuid not null,
  connection_id uuid not null,
  source_reference text not null check (char_length(source_reference) between 1 and 500),
  report_fingerprint text not null check (report_fingerprint ~ '^[0-9a-f]{64}$'),
  provider_payment_reference text not null check (char_length(provider_payment_reference) between 1 and 500),
  provider_refund_reference text not null check (char_length(provider_refund_reference) between 1 and 500),
  outcome text not null check (outcome in ('processing', 'completed', 'failed', 'unknown')),
  observed_at timestamptz not null,
  amount bigint not null check (amount between 1 and 9007199254740991),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  applied boolean not null default false,
  stale boolean not null default false,
  conflict_code text check (conflict_code is null or conflict_code = 'refund_report_conflict'),
  created_at timestamptz not null default clock_timestamp(),
  unique (id, site_id),
  unique (site_id, attempt_id, connection_id, source_reference, report_fingerprint),
  foreign key (order_id, site_id) references hpos.orders(id, site_id) on delete restrict,
  foreign key (attempt_id, site_id) references hpos.payment_attempts(id, site_id) on delete restrict,
  foreign key (connection_id) references hpos.payment_connections(id) on delete restrict
);

create index refund_reports_site_attempt_observed_idx
  on hpos.refund_reports (site_id, attempt_id, observed_at desc, created_at desc, id desc);
create index refund_reports_site_source_idx
  on hpos.refund_reports (site_id, connection_id, source_reference);

comment on table hpos.refund_reports is
  'Append-only Site-verified provider refund observations, including stale and conflicting evidence.';

create table hpos.refund_report_issues (
  id uuid primary key,
  site_id uuid not null,
  order_id uuid not null,
  attempt_id uuid not null,
  report_id uuid not null,
  code text not null check (code = 'refund_report_conflict'),
  status text not null default 'open' check (status in ('open', 'resolved')),
  message text not null check (char_length(message) between 1 and 1000),
  created_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  unique (report_id, code),
  foreign key (order_id, site_id) references hpos.orders(id, site_id) on delete restrict,
  foreign key (attempt_id, site_id) references hpos.payment_attempts(id, site_id) on delete restrict,
  foreign key (report_id, site_id) references hpos.refund_reports(id, site_id) on delete restrict,
  check ((status = 'open' and resolved_at is null) or (status = 'resolved' and resolved_at is not null))
);

create index refund_report_issues_order_idx
  on hpos.refund_report_issues (site_id, order_id, created_at desc, id desc);

comment on table hpos.refund_report_issues is
  'Staff-visible evidence issues created when a provider refund report contradicts the verified payment or refund ledger.';

-- Capacity is returned per unadmitted Ticket at full refund while the consumed
-- Reservation and prior Admission records remain intact for audit.
alter table hpos.tickets
  add column refund_capacity_released_at timestamptz;

comment on column hpos.tickets.refund_capacity_released_at is
  'Set once when a completed full Order refund returns this unadmitted Ticket to sale capacity.';
