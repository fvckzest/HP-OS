-- Keep bounded object cleanup fair across scheduled invocations.
create table if not exists hpos.photo_storage_cleanup_cursors (
  prefix text primary key,
  cursor text,
  updated_at timestamptz not null default clock_timestamp()
);

comment on table hpos.photo_storage_cleanup_cursors is
  'Durable fair cursors keep bounded orphan sweeps making progress across cron invocations.';
