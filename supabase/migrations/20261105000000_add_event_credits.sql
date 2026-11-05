alter table hpos.events
  add column performers text[] not null default '{}',
  add column artists text[] not null default '{}',
  add column vendors text[] not null default '{}';
