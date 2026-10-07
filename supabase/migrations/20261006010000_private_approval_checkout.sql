-- Issue #47: one-ticket checkout bound to one approved Access Request.
--
-- Quotes and Orders keep the approval association explicit. The attendee
-- snapshot is copied at Order creation so undoing or correcting a later
-- request cannot rewrite a paid Order or its issued Ticket identity.
alter table hpos.public_quotes
  add column access_request_id uuid,
  add column approval_token_id uuid,
  add constraint public_quotes_private_quantity_check
    check (access_request_id is null or quantity = 1);

alter table hpos.public_quotes
  add constraint public_quotes_access_request_fk
    foreign key (access_request_id, event_id, site_id)
    references hpos.access_requests(id, event_id, site_id) on delete restrict,
  add constraint public_quotes_approval_token_fk
    foreign key (approval_token_id, access_request_id, site_id)
    references hpos.access_request_approval_tokens(id, access_request_id, site_id) on delete restrict,
  add constraint public_quotes_private_approval_pair_check
    check ((access_request_id is null and approval_token_id is null)
      or (access_request_id is not null and approval_token_id is not null));

create index public_quotes_access_request_idx
  on hpos.public_quotes (site_id, access_request_id, created_at desc, id desc)
  where access_request_id is not null;

alter table hpos.orders
  add column access_request_id uuid,
  add column approved_attendee_name text,
  add column approved_attendee_email text,
  add column private_approval_consumed boolean not null default false,
  add constraint orders_access_request_fk
    foreign key (access_request_id, event_id, site_id)
    references hpos.access_requests(id, event_id, site_id) on delete restrict,
  add constraint orders_private_identity_key
    unique (id, access_request_id, event_id, site_id),
  add constraint orders_private_approval_consumed_public_check
    check (access_request_id is not null or private_approval_consumed = false),
  add constraint orders_private_approval_consumed_paid_check
    check (payment_status <> 'paid' or access_request_id is null or private_approval_consumed = true),
  add constraint orders_approved_attendee_snapshot_check
    check ((access_request_id is null and approved_attendee_name is null and approved_attendee_email is null)
      or (access_request_id is not null
        and approved_attendee_name is not null
        and approved_attendee_email is not null
        and char_length(btrim(approved_attendee_name)) between 1 and 200
        and char_length(btrim(approved_attendee_email)) between 1 and 254));

create index orders_access_request_idx
  on hpos.orders (site_id, access_request_id, created_at desc, id desc)
  where access_request_id is not null;

-- A failed/closed checkout may be replaced after provider closure. An
-- active checkout or any unresolved payment result remains the sole active
-- checkout for its approval, including a late result after withdrawal.
create unique index orders_one_private_active_checkout_idx
  on hpos.orders (site_id, access_request_id)
  where access_request_id is not null
    and (checkout_status in ('active', 'awaiting_payment_result')
      or payment_status in ('processing', 'unknown', 'conflicted'));

create unique index orders_one_private_consumed_purchase_idx
  on hpos.orders (site_id, access_request_id)
  where access_request_id is not null and private_approval_consumed = true;

alter table hpos.tickets
  add column approved_attendee_email text,
  add constraint tickets_approved_attendee_email_check
    check (approved_attendee_email is null or char_length(btrim(approved_attendee_email)) between 1 and 254);

comment on column hpos.public_quotes.access_request_id is
  'Private quote association; null for public checkout quotes.';
comment on column hpos.orders.access_request_id is
  'Approval that permitted this Order; null for public Orders. A successful or refunded Order consumes its approval.';
comment on column hpos.orders.private_approval_consumed is
  'Durable private approval consumption marker. Set with the first paid outcome and retained through conflict, refund, and late-report transitions.';
comment on column hpos.orders.approved_attendee_name is
  'Immutable approved private attendee name snapshot; independent from the payer checkout_identity.';
comment on column hpos.orders.approved_attendee_email is
  'Immutable approved private attendee email snapshot; independent from delivery_email and checkout_identity.';
comment on column hpos.tickets.approved_attendee_email is
  'Immutable approved private attendee email snapshot; null for public Tickets.';
