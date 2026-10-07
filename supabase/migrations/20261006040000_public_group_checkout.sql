-- Issue #50: public checkout supports a complete purchase of one to eight
-- Tickets. Private approval checkout remains constrained to one Ticket by
-- public_quotes_private_quantity_check.
alter table hpos.public_quotes
  drop constraint if exists public_quotes_quantity_check,
  add constraint public_quotes_quantity_check
    check (quantity between 1 and 8);

alter table hpos.reservations
  drop constraint if exists reservations_quantity_check,
  add constraint reservations_quantity_check
    check (quantity between 1 and 8);

comment on table hpos.public_quotes is
  'Site-owned, non-reserving public quotes for one to eight Tickets with explicit tax, buyer-fee, and Organization platform-fee snapshots; approved private quotes remain one Ticket.';
comment on table hpos.reservations is
  'Capacity holds for one to eight Tickets created atomically with unpaid Orders; expiry alone does not release capacity.';
