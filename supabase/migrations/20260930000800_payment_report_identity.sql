-- A stable provider source belongs to one payment attempt. Keep contradictory
-- observations as separate rows, including when a source is misrouted to a
-- different attempt.
do $migration$
declare
  existing_constraint text;
begin
  for existing_constraint in
    select conname
    from pg_constraint
    where conrelid = 'hpos.payment_attempt_reports'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) =
        'UNIQUE (site_id, connection_id, source_reference, report_fingerprint)'
  loop
    execute format('alter table hpos.payment_attempt_reports drop constraint %I', existing_constraint);
  end loop;
end;
$migration$;

alter table hpos.payment_attempt_reports
  add constraint payment_attempt_reports_source_fingerprint_key
  unique (site_id, attempt_id, connection_id, source_reference, report_fingerprint);

create unique index payment_attempts_provider_payment_reference_idx
  on hpos.payment_attempts (connection_id, provider_payment_reference)
  where provider_payment_reference is not null;
