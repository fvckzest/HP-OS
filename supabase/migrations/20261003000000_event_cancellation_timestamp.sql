alter table hpos.events
  add column canceled_at timestamptz;

update hpos.events
set canceled_at = updated_at
where is_canceled and canceled_at is null;

alter table hpos.events
  add constraint events_canceled_at_matches_status
  check ((is_canceled and canceled_at is not null) or (not is_canceled and canceled_at is null));
