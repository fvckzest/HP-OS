-- Store the buyer token needed by the durable initial email job. API reads use
-- the hash and never return this value; only the Site notification worker sees it.
alter table hpos.orders
  add column order_token text,
  add column delivery_status text not null default 'not_sent'
    check (delivery_status in ('not_sent', 'pending', 'sent', 'delivered', 'failed')),
  add column refund_status text not null default 'none'
    check (refund_status in ('none', 'partial', 'full')),
  add constraint orders_order_token_check
    check (order_token is null or order_token ~ '^[A-Za-z0-9_-]{32,128}$'),
  add constraint orders_order_token_unique unique (order_token);

comment on column hpos.orders.order_token is
  'Private Site-worker copy used only to enqueue the initial tickets_ready email; public API reads validate order_token_hash and never return this stored value.';

create table hpos.tickets (
  id uuid primary key,
  site_id uuid not null,
  order_id uuid not null,
  event_id uuid not null,
  offering_id uuid not null,
  ordinal smallint not null check (ordinal between 1 and 8),
  attendee_name text,
  ticket_token text not null check (ticket_token ~ '^[A-Za-z0-9_-]{32,128}$'),
  ticket_token_hash text not null check (ticket_token_hash ~ '^[0-9a-f]{64}$'),
  qr_payload text not null check (qr_payload ~ '^[A-Za-z0-9_-]{32,128}$'),
  qr_token_hash text not null check (qr_token_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  version integer not null default 1 check (version > 0),
  unique (id, site_id),
  unique (site_id, ticket_token_hash),
  unique (site_id, qr_token_hash),
  unique (order_id, ordinal),
  foreign key (order_id, event_id, site_id)
    references hpos.orders(id, event_id, site_id) on delete restrict,
  foreign key (offering_id, event_id, site_id)
    references hpos.ticket_offerings(id, event_id, site_id) on delete restrict
);

create index tickets_site_order_ordinal_idx
  on hpos.tickets (site_id, order_id, ordinal);

comment on table hpos.tickets is
  'Duplicate-safe issued Tickets. Page tokens and admission QR payloads are distinct; the Site receives them only through the Site-scoped buyer API and notification flow.';

create table hpos.payment_attempt_reports (
  id uuid primary key,
  site_id uuid not null,
  attempt_id uuid not null,
  connection_id uuid not null,
  source_reference text not null check (char_length(source_reference) between 1 and 500),
  report_fingerprint text not null check (report_fingerprint ~ '^[0-9a-f]{64}$'),
  provider_checkout_reference text not null check (char_length(provider_checkout_reference) between 1 and 500),
  provider_payment_reference text check (provider_payment_reference is null or char_length(provider_payment_reference) between 1 and 500),
  outcome text not null check (outcome in ('processing', 'paid', 'failed', 'canceled', 'unknown')),
  observed_at timestamptz not null,
  payment_started_at timestamptz,
  provider_can_take_payment boolean,
  amount bigint check (amount is null or amount between 0 and 9007199254740991),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  applied boolean not null default false,
  conflict_code text check (conflict_code is null or conflict_code = 'payment_report_conflict'),
  created_at timestamptz not null default clock_timestamp(),
  unique (id, site_id),
  unique (site_id, connection_id, source_reference, report_fingerprint),
  foreign key (attempt_id, site_id)
    references hpos.payment_attempts(id, site_id) on delete restrict,
  foreign key (connection_id)
    references hpos.payment_connections(id) on delete restrict,
  check ((amount is null and currency is null) or (amount is not null and currency is not null)),
  check (outcome <> 'paid' or (provider_payment_reference is not null and amount is not null and amount > 0 and currency is not null))
);

create index payment_attempt_reports_attempt_observed_idx
  on hpos.payment_attempt_reports (site_id, attempt_id, observed_at desc, id desc);
create index payment_attempt_reports_source_idx
  on hpos.payment_attempt_reports (site_id, connection_id, source_reference);

create table hpos.payment_report_issues (
  id uuid primary key,
  site_id uuid not null,
  order_id uuid not null,
  attempt_id uuid not null,
  report_id uuid not null,
  code text not null check (code in ('payment_report_conflict', 'reservation_already_released', 'event_canceled', 'order_token_missing')),
  message text not null check (char_length(message) between 1 and 1000),
  created_at timestamptz not null default clock_timestamp(),
  unique (report_id, code),
  foreign key (order_id, site_id) references hpos.orders(id, site_id) on delete restrict,
  foreign key (attempt_id, site_id) references hpos.payment_attempts(id, site_id) on delete restrict,
  foreign key (report_id, site_id) references hpos.payment_attempt_reports(id, site_id) on delete restrict
);

create index payment_report_issues_order_idx
  on hpos.payment_report_issues (site_id, order_id, created_at desc);
