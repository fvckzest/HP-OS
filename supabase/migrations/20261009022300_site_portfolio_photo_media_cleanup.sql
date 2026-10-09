-- Durable deletion queue for removed Photos and retired replacement attempts.
-- The queue intentionally has no Photo foreign key: Photo deletion cascades
-- must not erase the storage key needed by cleanup after commit.
create table hpos.photo_media_cleanup (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references hpos.sites(id) on delete cascade,
  photo_id uuid,
  attempt_number integer,
  variant text check (variant is null or variant in ('grid_400', 'artwork_1600')),
  storage_key text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed')),
  available_at timestamptz not null default clock_timestamp(),
  lease_expires_at timestamptz,
  lease_fence bigint not null default 0 check (lease_fence >= 0),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create index photo_media_cleanup_claim_idx
  on hpos.photo_media_cleanup (status, available_at, created_at, id);

comment on table hpos.photo_media_cleanup is
  'Durable post-commit deletion keys for removed Photos and retired non-active delivery attempts.';
