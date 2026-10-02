alter table hpos.notification_jobs
  add column failure_class text
  check (failure_class is null or failure_class in ('transient', 'permanent'));

alter table hpos.notification_dispatch_attempts
  add column failure_class text
  check (failure_class is null or failure_class in ('transient', 'permanent'));

comment on column hpos.notification_jobs.failure_class is
  'Explicit Site classification for the latest dispatch failure. Omitted failed reports default to transient; permanent failures stay failed until a guarded action changes the work.';

comment on column hpos.notification_dispatch_attempts.failure_class is
  'Explicit Site classification for this dispatch attempt. HP-OS never infers retryability from provider message text.';
