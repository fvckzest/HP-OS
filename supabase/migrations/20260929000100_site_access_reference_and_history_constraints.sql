-- Limit provider metadata to operator-defined, non-secret reference aliases.
-- Provider credentials remain in the Site backend's secret store.
alter table hpos.payment_connections
  add constraint payment_connections_account_reference_alias_check
    check (account_reference ~ '^ref:[A-Za-z0-9][A-Za-z0-9._:-]{0,245}$'),
  add constraint payment_connections_location_reference_alias_check
    check (location_reference is null or location_reference ~ '^ref:[A-Za-z0-9][A-Za-z0-9._:-]{0,245}$');

-- A Site or connection with assignment history cannot be deleted, because
-- existing Orders may still need to resolve the connection they used.
do $block$
declare
  original_foreign_key record;
begin
  for original_foreign_key in
    select constraint_row.conname
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'hpos.site_payment_connection_assignments'::regclass
      and constraint_row.contype = 'f'
      and constraint_row.confrelid in ('hpos.sites'::regclass, 'hpos.payment_connections'::regclass)
  loop
    execute format('alter table hpos.site_payment_connection_assignments drop constraint %I', original_foreign_key.conname);
  end loop;
end
$block$;

alter table hpos.site_payment_connection_assignments
  add constraint site_payment_assignment_site_history_fk
    foreign key (site_id, organization_id)
    references hpos.sites(id, organization_id) on delete restrict,
  add constraint site_payment_assignment_connection_history_fk
    foreign key (connection_id, organization_id)
    references hpos.payment_connections(id, organization_id) on delete restrict;

comment on column hpos.payment_connections.account_reference is
  'A non-secret operator-defined ref: alias used by the Site backend to select its own credential configuration.';
comment on column hpos.payment_connections.location_reference is
  'Optional non-secret operator-defined ref: alias used by the Site backend to select its own location configuration.';
