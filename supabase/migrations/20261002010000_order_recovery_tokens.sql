-- Store only hashes of short-lived Order recovery tokens. The raw token is
-- included only in the Site's durable recovery email job payload.
create table hpos.order_recovery_tokens (
  id uuid primary key,
  site_id uuid not null,
  order_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (order_id, site_id) references hpos.orders(id, site_id) on delete cascade,
  check (expires_at > created_at),
  check (revoked_at is null or revoked_at >= created_at)
);

create index order_recovery_tokens_site_order_idx
  on hpos.order_recovery_tokens (site_id, order_id, expires_at desc);

comment on table hpos.order_recovery_tokens is
  'Site-scoped, expiring Order page access grants. Only token hashes are stored; correcting the delivery email revokes these grants.';
