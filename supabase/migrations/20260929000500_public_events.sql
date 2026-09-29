-- API operations from every route share one Site-scoped idempotency namespace.
alter table hpos.notification_idempotency_records rename to api_idempotency_records;
alter table hpos.api_idempotency_records
  drop constraint notification_idempotency_records_check;
alter table hpos.api_idempotency_records
  add constraint api_idempotency_records_result_check
  check (
    (response_status is null and response_data is null and completed_at is null)
    or (response_status between 200 and 499 and response_data is not null and completed_at is not null)
  );
comment on table hpos.api_idempotency_records is
  'Site-scoped API idempotency fingerprints and replayable success or domain-error results. Used keys remain after the seven-day response replay window.';

create table hpos.events (
  id uuid primary key,
  site_id uuid not null references hpos.sites(id) on delete cascade,
  ticket_offering_id uuid not null,
  title text check (title is null or char_length(btrim(title)) between 1 and 200),
  description text check (description is null or char_length(description) <= 20000),
  venue_name text check (venue_name is null or char_length(btrim(venue_name)) between 1 and 200),
  venue_address text check (venue_address is null or char_length(venue_address) <= 1000),
  starts_at timestamptz,
  starts_at_offset_minutes smallint check (starts_at_offset_minutes between -840 and 840),
  ends_at timestamptz,
  ends_at_offset_minutes smallint check (ends_at_offset_minutes between -840 and 840),
  time_zone text check (time_zone is null or char_length(time_zone) between 1 and 100),
  check_in_opens_at timestamptz,
  check_in_opens_offset_minutes smallint check (check_in_opens_offset_minutes between -840 and 840),
  visibility text check (visibility is null or visibility in ('public', 'private')),
  publication_status text not null default 'draft' check (publication_status in ('draft', 'published')),
  is_canceled boolean not null default false,
  is_archived boolean not null default false,
  sales_paused boolean not null default false,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_actor_type text not null check (created_actor_type in ('user', 'system')),
  created_actor_reference text not null check (created_actor_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  updated_actor_type text not null check (updated_actor_type in ('user', 'system')),
  updated_actor_reference text not null check (updated_actor_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  unique (id, site_id),
  check (
    (starts_at is null and starts_at_offset_minutes is null)
    or (starts_at is not null and starts_at_offset_minutes is not null)
  ),
  check (
    (ends_at is null and ends_at_offset_minutes is null)
    or (ends_at is not null and ends_at_offset_minutes is not null)
  ),
  check (
    (check_in_opens_at is null and check_in_opens_offset_minutes is null)
    or (check_in_opens_at is not null and check_in_opens_offset_minutes is not null)
  ),
  check (starts_at is null or ends_at is null or ends_at > starts_at),
  check (check_in_opens_at is null or ends_at is null or check_in_opens_at <= ends_at)
);

create table hpos.ticket_offerings (
  id uuid primary key,
  event_id uuid not null,
  site_id uuid not null,
  price_amount bigint check (price_amount is null or price_amount between 1 and 9007199254740991),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  capacity bigint check (capacity is null or capacity between 0 and 9007199254740991),
  reserved_quantity bigint not null default 0 check (reserved_quantity >= 0),
  sales_opens_at timestamptz,
  sales_opens_offset_minutes smallint check (sales_opens_offset_minutes between -840 and 840),
  sales_closes_at timestamptz,
  sales_closes_offset_minutes smallint check (sales_closes_offset_minutes between -840 and 840),
  sales_ever_configured boolean not null default false,
  unique (event_id),
  unique (id, event_id, site_id),
  foreign key (event_id, site_id) references hpos.events(id, site_id) on delete cascade,
  check ((price_amount is null and currency is null) or (price_amount is not null and currency is not null)),
  check (capacity is null or reserved_quantity <= capacity),
  check (
    (sales_opens_at is null and sales_opens_offset_minutes is null)
    or (sales_opens_at is not null and sales_opens_offset_minutes is not null)
  ),
  check (
    (sales_closes_at is null and sales_closes_offset_minutes is null)
    or (sales_closes_at is not null and sales_closes_offset_minutes is not null)
  ),
  check (sales_opens_at is null or sales_closes_at is null or sales_closes_at > sales_opens_at)
);

alter table hpos.events
  add constraint events_ticket_offering_fk
    foreign key (ticket_offering_id, id, site_id)
    references hpos.ticket_offerings(id, event_id, site_id)
    on delete cascade
    deferrable initially deferred;

create index events_site_admin_list_idx
  on hpos.events (site_id, created_at desc, id asc);
create index events_site_public_current_idx
  on hpos.events (site_id, starts_at asc, id asc)
  where publication_status = 'published' and is_archived = false;
create index events_site_public_past_idx
  on hpos.events (site_id, starts_at desc, id asc)
  where publication_status = 'published';

comment on table hpos.events is
  'Site-owned Event records. Draft configuration is nullable; public access is limited to published Events.';
comment on column hpos.events.ticket_offering_id is
  'Deferred composite foreign key ensures each Event commits with exactly one Site-matched Ticket offering.';
comment on table hpos.ticket_offerings is
  'One priced admission option and capacity record per Event. Provider credentials and catalog metadata are not stored here.';
