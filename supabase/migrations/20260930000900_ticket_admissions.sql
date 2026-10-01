-- One Admission is allowed per Ticket, with Site and Event ownership enforced in PostgreSQL.
alter table hpos.tickets
  add constraint tickets_id_event_site_unique unique (id, event_id, site_id);

create table hpos.admissions (
  id uuid primary key,
  site_id uuid not null,
  event_id uuid not null,
  ticket_id uuid not null,
  actor_type text not null check (actor_type in ('user', 'system')),
  actor_reference text not null check (actor_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  admitted_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  unique (ticket_id),
  unique (site_id, ticket_id),
  foreign key (ticket_id, event_id, site_id)
    references hpos.tickets(id, event_id, site_id) on delete restrict,
  foreign key (event_id, site_id)
    references hpos.events(id, site_id) on delete restrict
);

create index admissions_site_event_time_idx
  on hpos.admissions (site_id, event_id, admitted_at desc, id desc);

comment on table hpos.admissions is
  'One immutable, Site- and Event-scoped entry record per Ticket, created online through the Admission API.';
comment on column hpos.admissions.actor_reference is
  'Site-local staff identity supplied by the authenticated Site backend; HP-OS does not evaluate individual staff roles.';

