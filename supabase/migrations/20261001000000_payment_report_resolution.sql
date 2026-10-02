-- Keep conflicting payment observations open until staff records a guarded,
-- verified resolution. The original reports and issue messages remain
-- immutable; successful resolutions are recorded separately as an audit trail.
alter table hpos.payment_report_issues
  add column status text not null default 'open'
    check (status in ('open', 'resolved')),
  add column resolved_at timestamptz,
  add constraint payment_report_issues_resolution_state_check check (
    (status = 'open' and resolved_at is null)
    or (status = 'resolved' and resolved_at is not null)
  ),
  add constraint payment_report_issues_site_identity_key unique (id, site_id);

create table hpos.payment_report_issue_resolutions (
  id uuid primary key,
  site_id uuid not null,
  issue_id uuid not null,
  order_id uuid not null,
  attempt_id uuid not null,
  report_id uuid not null,
  actor_type text not null check (actor_type in ('user', 'system')),
  actor_reference text not null check (char_length(btrim(actor_reference)) between 1 and 200),
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  verification_reference text not null check (char_length(btrim(verification_reference)) between 1 and 500),
  previous_version integer not null check (previous_version > 0),
  new_version integer not null check (new_version > previous_version),
  created_at timestamptz not null default clock_timestamp(),
  unique (issue_id),
  unique (id, site_id),
  foreign key (issue_id, site_id)
    references hpos.payment_report_issues(id, site_id) on delete restrict,
  foreign key (order_id, site_id)
    references hpos.orders(id, site_id) on delete restrict,
  foreign key (attempt_id, site_id)
    references hpos.payment_attempts(id, site_id) on delete restrict,
  foreign key (report_id, site_id)
    references hpos.payment_attempt_reports(id, site_id) on delete restrict
);

create index payment_report_issue_resolutions_attempt_idx
  on hpos.payment_report_issue_resolutions (site_id, attempt_id, created_at desc);

comment on table hpos.payment_report_issue_resolutions is
  'Successful guarded payment-conflict resolutions. Actor, reason, and non-secret verification references are retained without provider credentials.';
