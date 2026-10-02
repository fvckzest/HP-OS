-- Retain durable evidence when a confirmed payment cannot finish Ticket
-- issuance. The issue is resolved only after the complete Ticket set and its
-- initial delivery job commit successfully.
alter table hpos.payment_report_issues
  drop constraint payment_report_issues_code_check,
  add constraint payment_report_issues_code_check check (
    code in (
      'payment_report_conflict',
      'reservation_already_released',
      'event_canceled',
      'order_token_missing',
      'ticket_issuance_failed',
      'order_fully_refunded'
    )
  );

comment on column hpos.payment_report_issues.code is
  'Durable payment, Ticket issuance, and fulfillment investigation code. Issues remain visible until their guarded resolution or successful recovery.';

create table hpos.order_recovery_actions (
  id uuid primary key,
  site_id uuid not null,
  order_id uuid not null,
  action text not null check (action in ('retry_ticket_issuance')),
  actor_type text not null check (actor_type in ('user', 'system')),
  actor_reference text not null check (char_length(btrim(actor_reference)) between 1 and 200),
  previous_version integer not null check (previous_version > 0),
  new_version integer not null check (new_version > previous_version),
  created_at timestamptz not null default clock_timestamp(),
  unique (id, site_id),
  foreign key (order_id, site_id) references hpos.orders(id, site_id) on delete restrict
);

create index order_recovery_actions_order_idx
  on hpos.order_recovery_actions (site_id, order_id, created_at desc, id desc);

comment on table hpos.order_recovery_actions is
  'Durable actor and version history for guarded Order recovery actions.';
