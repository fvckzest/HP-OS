-- A failed replacement keeps its failure code while the active attempt stays
-- ready and public. Processing replacements have no failure code yet.
alter table hpos.photos drop constraint photos_replacement_state_check;
alter table hpos.photos
  add constraint photos_replacement_state_check check (
    (replacement_status is null and replacement_attempt is null and replacement_failure_code is null and replacement_ready_variants = '{}')
    or (replacement_status = 'processing' and replacement_attempt is not null and replacement_failure_code is null)
    or (replacement_status = 'failed' and replacement_attempt is not null and replacement_failure_code = 'delivery_variants_failed')
  );
