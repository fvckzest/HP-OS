alter table hpos.events add column if not exists event_type text;
alter table hpos.events drop constraint if exists events_event_type_check;
alter table hpos.events add constraint events_event_type_check
  check (event_type is null or event_type in ('concert', 'exhibition', 'festival', 'club'));
