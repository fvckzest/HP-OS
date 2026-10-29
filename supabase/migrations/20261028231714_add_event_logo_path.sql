alter table hpos.events add column if not exists logo_path text;
alter table hpos.events drop constraint if exists events_logo_path_check;
alter table hpos.events add constraint events_logo_path_check
  check (logo_path is null or (char_length(logo_path) <= 500 and logo_path ~ '^(/[A-Za-z0-9_][A-Za-z0-9_.-]*)+$'));
