-- Preserve the Site's actor assertion for every accepted Photo upload attempt.
-- Initial uploads, retries, and replacements each create a durable processing
-- job, so the attempt table is the source of audit attribution.
alter table hpos.photo_processing_jobs
  add column actor_type text,
  add column actor_reference text;

-- Earlier local or pre-audit job rows cannot recover the original request
-- actor. Mark those rows explicitly; all new API writes supply their actor.
update hpos.photo_processing_jobs
   set actor_type = 'system',
       actor_reference = 'migration:pre-photo-audit'
 where actor_type is null or actor_reference is null;

alter table hpos.photo_processing_jobs
  alter column actor_type set not null,
  alter column actor_reference set not null,
  add constraint photo_processing_jobs_actor_type_check
    check (actor_type in ('user', 'system')),
  add constraint photo_processing_jobs_actor_reference_check
    check (actor_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$');

comment on column hpos.photo_processing_jobs.actor_type is
  'Actor type asserted by the Site when this Photo upload, retry, or replacement attempt was accepted.';
comment on column hpos.photo_processing_jobs.actor_reference is
  'Non-secret Site-local actor reference asserted for this Photo processing attempt.';
