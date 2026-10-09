-- Issue #122: fence every durable Photo processing lease.
-- A worker increments this value when it claims an expired job. Completion and
-- failure writes must match the value returned by that claim.
alter table hpos.photo_processing_jobs
  add column lease_fence bigint not null default 0;

alter table hpos.photo_processing_jobs
  add constraint photo_processing_jobs_lease_fence_check
  check (lease_fence >= 0);

comment on column hpos.photo_processing_jobs.lease_fence is
  'Monotonically increasing worker lease fence. Stale workers cannot commit state or clean a source after a later claim.';
