-- Issue #123: versioned Photo attempts and guarded curation state.
-- Existing delivery rows remain addressable by attempt_number so a replacement
-- can be built completely before the active attempt changes.
alter table hpos.photos
  add column active_attempt integer not null default 1,
  add column is_hero boolean not null default false,
  add column replacement_attempt integer,
  add column replacement_status text,
  add column replacement_ready_variants text[] not null default '{}',
  add column replacement_failure_code text;

alter table hpos.photos
  add constraint photos_active_attempt_check check (active_attempt > 0),
  add constraint photos_replacement_attempt_check check (replacement_attempt is null or replacement_attempt > 0),
  add constraint photos_replacement_status_check check (replacement_status is null or replacement_status in ('processing', 'failed')),
  add constraint photos_replacement_variants_check check (replacement_ready_variants <@ array['grid_400', 'artwork_1600']::text[]),
  add constraint photos_replacement_failure_check check (replacement_failure_code is null or replacement_failure_code = 'delivery_variants_failed'),
  add constraint photos_replacement_state_check check (
    (replacement_status is null and replacement_attempt is null and replacement_failure_code is null and replacement_ready_variants = '{}')
    or (replacement_status is not null and replacement_attempt is not null and replacement_failure_code is null)
  );

alter table hpos.photo_variants
  add column attempt_number integer not null default 1;

alter table hpos.photo_variants
  drop constraint photo_variants_pkey;

alter table hpos.photo_variants
  add constraint photo_variants_pkey primary key (photo_id, attempt_number, variant),
  add constraint photo_variants_attempt_check check (attempt_number > 0);

create index photo_variants_active_lookup_idx
  on hpos.photo_variants (site_id, photo_id, attempt_number, variant);

create unique index photos_one_hero_per_artwork_idx
  on hpos.photos (site_id, artwork_id)
  where is_hero;

alter table hpos.photo_processing_jobs
  add column operation text not null default 'initial';

alter table hpos.photo_processing_jobs
  add constraint photo_processing_jobs_operation_check
    check (operation in ('initial', 'retry', 'replacement'));

comment on column hpos.photos.active_attempt is
  'Attempt whose complete variant pair is currently public; replacement attempts never change this until both variants are committed.';
comment on column hpos.photos.replacement_status is
  'Private replacement lifecycle while the current active attempt remains ready and public.';
comment on column hpos.photo_processing_jobs.operation is
  'Worker state transition branch: initial upload, failed Photo retry, or ready Photo replacement.';
