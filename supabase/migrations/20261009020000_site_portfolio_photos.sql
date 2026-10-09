-- Issue #122: complete Photo upload acceptance and durable initial processing.
-- The private database id is kept separate from the opaque Site-scoped photo_id.
create table hpos.photos (
  id uuid primary key default gen_random_uuid(),
  photo_id text not null,
  site_id uuid not null references hpos.sites(id) on delete cascade,
  artwork_id text not null,
  position integer not null check (position > 0),
  status text not null default 'processing'
    check (status in ('processing', 'ready', 'failed')),
  ready_variants text[] not null default '{}'
    check (ready_variants <@ array['grid_400', 'artwork_1600']::text[]),
  failure_code text
    check (failure_code is null or failure_code = 'delivery_variants_failed'),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (photo_id, site_id),
  unique (id, site_id),
  unique (artwork_id, site_id, position),
  constraint photos_photo_id_format_check
    check (photo_id ~ '^photo_[A-Za-z0-9_-]{22}$'),
  constraint photos_artwork_fk
    foreign key (artwork_id, site_id)
    references hpos.artworks (artwork_id, site_id)
    on delete cascade,
  constraint photos_status_fields_check
    check (
      (status = 'failed' and failure_code is not null)
      or (status in ('processing', 'ready') and failure_code is null)
    ),
  constraint photos_ready_state_check
    check (
      (status = 'ready' and ready_variants @> array['grid_400', 'artwork_1600']::text[])
      or status <> 'ready'
    )
);

create index photos_site_artwork_order_idx
  on hpos.photos (site_id, artwork_id, position);
create index photos_site_status_idx
  on hpos.photos (site_id, status, updated_at);

create table hpos.photo_variants (
  photo_id uuid not null,
  site_id uuid not null,
  variant text not null check (variant in ('grid_400', 'artwork_1600')),
  storage_key text not null,
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  byte_size bigint not null check (byte_size > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (photo_id, variant),
  foreign key (photo_id, site_id)
    references hpos.photos (id, site_id)
    on delete cascade
);

create index photo_variants_site_lookup_idx
  on hpos.photo_variants (site_id, photo_id, variant);

create table hpos.photo_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references hpos.sites(id) on delete cascade,
  artwork_id text not null,
  photo_id uuid not null,
  attempt_number integer not null check (attempt_number > 0),
  source_storage_key text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default clock_timestamp(),
  lease_expires_at timestamptz,
  last_error text,
  source_deleted_at timestamptz,
  source_delete_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (photo_id, attempt_number),
  foreign key (artwork_id, site_id)
    references hpos.artworks (artwork_id, site_id)
    on delete cascade,
  foreign key (photo_id, site_id)
    references hpos.photos (id, site_id)
    on delete cascade
);

create index photo_processing_jobs_claim_idx
  on hpos.photo_processing_jobs (status, available_at, created_at, id);
create index photo_processing_jobs_site_idx
  on hpos.photo_processing_jobs (site_id, status, updated_at);

-- A staging row gives the bounded cleanup worker an authoritative list of
-- temporary upload keys, including uploads that never reached Photo creation.
create table hpos.photo_upload_staging (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references hpos.sites(id) on delete cascade,
  storage_key text not null unique,
  byte_size bigint not null check (byte_size >= 0),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  finalized_at timestamptz
);

create index photo_upload_staging_expiry_idx
  on hpos.photo_upload_staging (expires_at)
  where finalized_at is null;

comment on table hpos.photos is
  'Site-owned Photo records. photo_id is an opaque public API identifier; id is private and is used by processing tables.';
comment on table hpos.photo_processing_jobs is
  'Durable initial Photo processing work. A source key is retained only for the active attempt and is deleted on completion or failure.';
comment on table hpos.photo_upload_staging is
  'Temporary upload keys are bounded by a 24-hour expiry so incomplete transfers cannot accumulate indefinitely.';
