-- Issue #120: Site-scoped Artwork draft records. The Artwork API identifier is
-- intentionally stable for the resource lifetime and is also the composite-FK
-- target for the Collection and Photo portfolio slices.
create table hpos.artworks (
  id uuid primary key default gen_random_uuid(),
  artwork_id text not null,
  site_id uuid not null references hpos.sites(id) on delete cascade,
  slug text,
  displayed_artwork_id text not null,
  title text not null,
  description text,
  medium text,
  dimensions jsonb,
  created_on date,
  cardano_chain text,
  cardano_policy_id text,
  cardano_asset_id text,
  original_status text not null default 'available'
    check (original_status in ('available', 'sold')),
  publication_status text not null default 'draft'
    check (publication_status in ('draft', 'published', 'archived')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_actor_type text not null check (created_actor_type in ('user', 'system')),
  created_actor_reference text not null check (created_actor_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  updated_actor_type text not null check (updated_actor_type in ('user', 'system')),
  updated_actor_reference text not null check (updated_actor_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  unique (artwork_id, site_id),
  constraint artworks_artwork_id_format_check
    check (artwork_id ~ '^art_[A-Za-z0-9_-]{22}$'),
  constraint artworks_slug_format_check
    check (slug is null or slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint artworks_displayed_id_length_check
    check (char_length(btrim(displayed_artwork_id)) between 1 and 200),
  constraint artworks_title_length_check
    check (char_length(btrim(title)) between 1 and 200),
  constraint artworks_description_length_check
    check (description is null or char_length(description) <= 20000),
  constraint artworks_medium_length_check
    check (medium is null or char_length(btrim(medium)) between 1 and 200),
  constraint artworks_slug_length_check
    check (slug is null or char_length(slug) between 1 and 120),
  constraint artworks_dimensions_check
    check (
      dimensions is null
      or (
        jsonb_typeof(dimensions) = 'object'
        and dimensions ? 'width'
        and dimensions ? 'height'
        and dimensions ? 'unit'
        and jsonb_typeof(dimensions->'width') = 'number'
        and jsonb_typeof(dimensions->'height') = 'number'
        and (dimensions->>'width')::numeric > 0
        and (dimensions->>'height')::numeric > 0
        and dimensions->>'unit' in ('mm', 'cm', 'in')
      )
    )
);

create unique index artworks_site_displayed_id_idx
  on hpos.artworks (site_id, displayed_artwork_id);

create unique index artworks_site_slug_idx
  on hpos.artworks (site_id, slug)
  where slug is not null;

create index artworks_site_admin_list_idx
  on hpos.artworks (site_id, updated_at desc, artwork_id asc);

comment on table hpos.artworks is
  'Site-owned Artwork records. artwork_id is the stable Site-scoped API identifier and the composite key target for later portfolio tables.';
comment on column hpos.artworks.artwork_id is
  'Stable opaque Site-scoped Artwork API identifier; it is never changed by edits and is distinct from the private database id and displayed_artwork_id.';
