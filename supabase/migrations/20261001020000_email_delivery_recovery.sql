-- Keep delivery recovery actions in the same durable, Site-scoped audit
-- history as guarded Ticket issuance recovery.
alter table hpos.order_recovery_actions
  drop constraint order_recovery_actions_action_check,
  add constraint order_recovery_actions_action_check check (
    action in ('retry_ticket_issuance', 'resend_ticket_email', 'correct_delivery_email')
  ),
  add column reason text,
  add column verification_reference text;

alter table hpos.order_recovery_actions
  add constraint order_recovery_actions_reason_check check (reason is null or char_length(btrim(reason)) between 1 and 500),
  add constraint order_recovery_actions_verification_reference_check check (verification_reference is null or char_length(btrim(verification_reference)) between 1 and 500);

comment on column hpos.order_recovery_actions.action is
  'Guarded Order recovery action: Ticket issuance retry, existing-Ticket resend, or verified delivery-email correction.';
