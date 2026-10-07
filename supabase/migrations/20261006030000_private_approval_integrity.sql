-- Issue #47: bind a consumed Order to the exact Access Request that permitted
-- it. This constraint follows the private checkout migration because both
-- sides of the association must exist before PostgreSQL can enforce it.
alter table hpos.access_requests
  add constraint access_requests_paid_order_identity_fk
    foreign key (paid_order_id, id, event_id, site_id)
    references hpos.orders(id, access_request_id, event_id, site_id) on delete restrict;

alter table hpos.access_requests
  drop constraint access_requests_paid_order_event_fk;
