-- Issue #43: operational lists, consistent sales totals, and attributable fee
-- components. Fee observations are append-only so provider revisions and
-- contradictory evidence remain available for staff investigation.
create table hpos.fee_records (
  id uuid primary key,
  site_id uuid not null,
  order_id uuid not null,
  attempt_id uuid not null,
  connection_id uuid not null,
  scope_type text not null check (scope_type in ('payment', 'refund')),
  scope_reference text not null check (char_length(scope_reference) between 1 and 500),
  source_reference text not null check (char_length(source_reference) between 1 and 500),
  source_revision bigint not null check (source_revision between 1 and 9007199254740991),
  category text not null check (category in ('processing', 'platform')),
  direction text not null check (direction in ('charge', 'return')),
  amount bigint not null check (amount between 0 and 9007199254740991),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  observed_at timestamptz not null,
  actor_type text not null check (actor_type in ('user', 'system')),
  actor_reference text not null check (char_length(btrim(actor_reference)) between 1 and 200),
  report_fingerprint text not null check (report_fingerprint ~ '^[0-9a-f]{64}$'),
  conflict_code text check (conflict_code is null or conflict_code = 'fee_report_conflict'),
  created_at timestamptz not null default clock_timestamp(),
  unique (id, site_id),
  unique (site_id, connection_id, source_reference, category, direction, source_revision, report_fingerprint),
  foreign key (order_id, site_id) references hpos.orders(id, site_id) on delete restrict,
  foreign key (attempt_id, site_id) references hpos.payment_attempts(id, site_id) on delete restrict,
  foreign key (connection_id) references hpos.payment_connections(id) on delete restrict,
  check ((scope_type = 'payment' and direction in ('charge', 'return')) or scope_type = 'refund')
);

create index fee_records_order_idx
  on hpos.fee_records (site_id, order_id, created_at asc, id asc);
create index fee_records_component_idx
  on hpos.fee_records (site_id, connection_id, source_reference, category, direction, source_revision desc, created_at desc);

create table hpos.fee_confirmations (
  id uuid primary key,
  site_id uuid not null,
  order_id uuid not null,
  attempt_id uuid not null,
  connection_id uuid not null,
  scope_type text not null check (scope_type in ('payment', 'refund')),
  scope_reference text not null check (char_length(scope_reference) between 1 and 500),
  category text not null check (category in ('processing', 'platform')),
  actor_type text not null check (actor_type in ('user', 'system')),
  actor_reference text not null check (char_length(btrim(actor_reference)) between 1 and 200),
  observed_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (id, site_id),
  foreign key (order_id, site_id) references hpos.orders(id, site_id) on delete restrict,
  foreign key (attempt_id, site_id) references hpos.payment_attempts(id, site_id) on delete restrict,
  foreign key (connection_id) references hpos.payment_connections(id) on delete restrict
);

create index fee_confirmations_scope_idx
  on hpos.fee_confirmations (site_id, attempt_id, connection_id, scope_type, scope_reference, category, created_at desc, id desc);

create table hpos.fee_confirmation_totals (
  id uuid primary key,
  site_id uuid not null,
  confirmation_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  charged bigint not null check (charged between 0 and 9007199254740991),
  returned bigint not null check (returned between 0 and 9007199254740991),
  unique (confirmation_id, currency),
  foreign key (confirmation_id, site_id) references hpos.fee_confirmations(id, site_id) on delete restrict
);

create index fee_confirmation_totals_site_idx
  on hpos.fee_confirmation_totals (site_id, currency);

create table hpos.fee_report_issues (
  id uuid primary key,
  site_id uuid not null,
  order_id uuid not null,
  attempt_id uuid not null,
  fee_record_id uuid,
  code text not null check (code in ('fee_report_conflict', 'planned_platform_fee_discrepancy')),
  message text not null check (char_length(message) between 1 and 1000),
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  unique (fee_record_id, code),
  foreign key (order_id, site_id) references hpos.orders(id, site_id) on delete restrict,
  foreign key (attempt_id, site_id) references hpos.payment_attempts(id, site_id) on delete restrict,
  foreign key (fee_record_id, site_id) references hpos.fee_records(id, site_id) on delete restrict,
  check ((status = 'open' and resolved_at is null) or (status = 'resolved' and resolved_at is not null))
);

create index fee_report_issues_order_idx
  on hpos.fee_report_issues (site_id, order_id, created_at desc, id desc);

comment on table hpos.fee_records is
  'Append-only provider-confirmed fee components, including revisions and conflicting evidence; amounts are never estimates.';
comment on table hpos.fee_confirmations is
  'Site declarations that a payment or completed refund fee category is complete as observed at a point in time.';
comment on table hpos.fee_confirmation_totals is
  'The complete currency set for one fee confirmation; zero is explicit and omitted currencies remain unknown.';
