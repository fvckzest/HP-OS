-- Scheduler responses and logs expose each processing run. Durable work is
-- recorded in notification_jobs, so a separate singleton status table is not
-- needed by the public API or either scheduler.
drop table if exists hpos.processing_state;
