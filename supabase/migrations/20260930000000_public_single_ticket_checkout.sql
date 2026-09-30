-- Organization fee inputs are explicit operator setup. A missing rate keeps
-- checkout unavailable instead of silently treating an unknown fee as zero.
alter table hpos.organizations
  drop constraint organizations_fee_terms_status_check;
alter table hpos.organizations
  add column platform_fee_basis_points smallint,
  add constraint organizations_platform_fee_basis_points_check
    check (platform_fee_basis_points is null or platform_fee_basis_points between 0 and 10000),
  add constraint organizations_fee_terms_status_check
    check (fee_terms_status in ('pending_validation', 'configured')),
  add constraint organizations_fee_configuration_check
    check (
      (fee_terms_status = 'pending_validation' and platform_fee_basis_points is null)
      or (fee_terms_status = 'configured' and platform_fee_basis_points is not null)
    );

comment on column hpos.organizations.platform_fee_basis_points is
  'Operator-configured platform fee in basis points, applied to the pre-tax ticket subtotal. Null means checkout pricing is unavailable.';

-- A per-Ticket tax amount must be supplied explicitly. An amount of zero means
-- the operator has confirmed that no tax applies. [] explicitly means no buyer fee.
alter table hpos.ticket_offerings
  add column tax_amount bigint,
  add column buyer_fees jsonb,
  add constraint ticket_offerings_tax_amount_check
    check (tax_amount is null or tax_amount between 0 and 9007199254740991),
  add constraint ticket_offerings_buyer_fees_check
    check (buyer_fees is null or jsonb_typeof(buyer_fees) = 'array');

comment on column hpos.ticket_offerings.tax_amount is
  'Explicit tax amount per Ticket in the offering currency; null means tax configuration is unknown.';
comment on column hpos.ticket_offerings.buyer_fees is
  'Explicit buyer-facing fee entries per Ticket; null means configuration is unknown and [] means no buyer-facing fees.';

create table hpos.buyers (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references hpos.sites(id) on delete cascade,
  normalized_email text not null check (char_length(normalized_email) between 1 and 254),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (site_id, normalized_email),
  unique (id, site_id)
);

create table hpos.public_quotes (
  id uuid primary key,
  site_id uuid not null,
  event_id uuid not null,
  offering_id uuid not null,
  quantity smallint not null default 1 check (quantity = 1),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  unit_price bigint not null check (unit_price between 1 and 9007199254740991),
  subtotal bigint not null check (subtotal between 1 and 9007199254740991),
  buyer_fees jsonb not null check (jsonb_typeof(buyer_fees) = 'array'),
  tax_total bigint not null check (tax_total between 0 and 9007199254740991),
  total bigint not null check (total between 1 and 9007199254740991),
  platform_fee_basis_points smallint not null check (platform_fee_basis_points between 0 and 10000),
  platform_fee_amount bigint not null check (platform_fee_amount between 0 and 9007199254740991),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  check (subtotal = unit_price * quantity),
  check (total >= subtotal + tax_total),
  check (expires_at > created_at),
  unique (id, site_id),
  foreign key (event_id, site_id) references hpos.events(id, site_id) on delete cascade,
  foreign key (offering_id, event_id, site_id) references hpos.ticket_offerings(id, event_id, site_id) on delete cascade
);

create index public_quotes_site_expiry_idx on hpos.public_quotes (site_id, expires_at);

create table hpos.orders (
  id uuid primary key,
  site_id uuid not null,
  event_id uuid not null,
  offering_id uuid not null,
  buyer_id uuid not null,
  quote_id uuid not null,
  order_reference text not null check (order_reference ~ '^[A-Z0-9-]{8,24}$'),
  buyer_name text not null check (char_length(btrim(buyer_name)) between 1 and 200),
  delivery_email text not null check (char_length(delivery_email) between 1 and 254),
  checkout_identity jsonb not null,
  accepted_quote jsonb not null,
  checkout_status text not null default 'active' check (checkout_status in ('active', 'awaiting_payment_result', 'expired', 'ended')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'processing', 'paid', 'failed', 'unknown', 'conflicted')),
  issuance_status text not null default 'not_started' check (issuance_status in ('not_started', 'pending', 'issued', 'failed', 'blocked')),
  checkout_expires_at timestamptz not null,
  order_token_hash text not null unique check (order_token_hash ~ '^[0-9a-f]{64}$'),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, event_id, site_id),
  unique (id, site_id),
  unique (site_id, order_reference),
  unique (quote_id),
  foreign key (event_id, site_id) references hpos.events(id, site_id) on delete restrict,
  foreign key (offering_id, event_id, site_id) references hpos.ticket_offerings(id, event_id, site_id) on delete restrict,
  foreign key (buyer_id, site_id) references hpos.buyers(id, site_id) on delete restrict,
  foreign key (quote_id, site_id) references hpos.public_quotes(id, site_id) on delete restrict
);

create index orders_site_recent_idx on hpos.orders (site_id, created_at desc, id);
create index orders_event_active_idx on hpos.orders (event_id, checkout_expires_at)
  where checkout_status in ('active', 'awaiting_payment_result');

create table hpos.reservations (
  id uuid primary key,
  site_id uuid not null,
  event_id uuid not null,
  offering_id uuid not null,
  order_id uuid not null,
  quantity smallint not null default 1 check (quantity = 1),
  status text not null default 'held' check (status in ('held', 'consumed', 'released')),
  expires_at timestamptz not null,
  awaiting_provider_verification boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (order_id),
  foreign key (order_id, event_id, site_id) references hpos.orders(id, event_id, site_id) on delete restrict,
  foreign key (offering_id, event_id, site_id) references hpos.ticket_offerings(id, event_id, site_id) on delete restrict
);

create index reservations_expiry_idx on hpos.reservations (expires_at, id)
  where status = 'held';

comment on table hpos.public_quotes is
  'Site-owned, non-reserving single-Ticket quotes with explicit tax, buyer-fee, and Organization platform-fee snapshots.';
comment on table hpos.orders is
  'Site-owned unpaid checkout Orders with immutable buyer identity and accepted pricing snapshots.';
comment on table hpos.reservations is
  'Capacity holds created atomically with unpaid Orders; expiry alone does not release capacity.';
