-- Keep the provider resource mapping selected for an offering scoped to one
-- payment connection. Orders copy this value when they are created, so a
-- later mapping change cannot rewrite an older checkout.
alter table hpos.orders
  add column provider_mapping jsonb,
  add constraint orders_provider_mapping_check check (
    provider_mapping is null or jsonb_typeof(provider_mapping) = 'object'
  );

create table hpos.ticket_offering_provider_mappings (
  offering_id uuid not null,
  event_id uuid not null,
  site_id uuid not null,
  connection_id uuid not null,
  resource_type text not null check (char_length(resource_type) between 1 and 100),
  resource_reference text not null check (char_length(resource_reference) between 1 and 500),
  verified_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (offering_id, connection_id),
  foreign key (offering_id, event_id, site_id)
    references hpos.ticket_offerings(id, event_id, site_id) on delete restrict,
  foreign key (connection_id)
    references hpos.payment_connections(id) on delete restrict
);

create index ticket_offering_provider_mappings_event_idx
  on hpos.ticket_offering_provider_mappings (site_id, event_id, offering_id);

comment on table hpos.ticket_offering_provider_mappings is
  'Current non-secret provider resource mapping per Ticket offering and payment connection. Orders retain their own mapping snapshot.';
comment on column hpos.orders.provider_mapping is
  'Provider resource mapping copied when the Order was created; later Event mapping edits never change this snapshot.';
