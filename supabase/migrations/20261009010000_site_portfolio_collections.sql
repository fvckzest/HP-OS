-- Site-scoped Collection records and independent Artwork membership order.
-- This migration follows the Artwork foundation from issue #120.  The
-- composite foreign keys keep a record from one Site from being referenced
-- through another Site's Collection or membership.

create table hpos.collections (
  id uuid primary key default gen_random_uuid(),
  collection_id text not null,
  site_id uuid not null references hpos.sites(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  description text check (description is null or char_length(description) <= 20000),
  is_active boolean not null default true,
  position integer not null check (position > 0),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_actor_type text not null check (created_actor_type in ('user', 'system')),
  created_actor_reference text not null check (created_actor_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  updated_actor_type text not null check (updated_actor_type in ('user', 'system')),
  updated_actor_reference text not null check (updated_actor_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  unique (id, site_id),
  unique (collection_id, site_id),
  unique (site_id, position) deferrable initially deferred,
  constraint collections_collection_id_format_check
    check (collection_id ~ '^col_[A-Za-z0-9_-]{22}$')
);

create table hpos.collection_artworks (
  collection_id text not null,
  artwork_id text not null,
  site_id uuid not null,
  position integer not null check (position > 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (collection_id, artwork_id, site_id),
  unique (site_id, collection_id, position) deferrable initially deferred,
  primary key (collection_id, artwork_id, site_id),
  foreign key (collection_id, site_id)
    references hpos.collections(collection_id, site_id)
    on delete cascade,
  foreign key (artwork_id, site_id)
    references hpos.artworks(artwork_id, site_id)
    on delete cascade
);

create index collections_site_position_idx
  on hpos.collections (site_id, position, collection_id);

create index collection_artworks_site_order_idx
  on hpos.collection_artworks (site_id, collection_id, position, artwork_id);

comment on table hpos.collections is
  'Site-owned ordered Collections. id is private database identity; collection_id is the opaque Site-scoped API identifier. Deactivation retains metadata and Artwork memberships while excluding the Collection from public reads.';

comment on table hpos.collection_artworks is
  'Site-scoped Collection membership. Position is independent for each Collection and remains when its Collection is inactive.';
