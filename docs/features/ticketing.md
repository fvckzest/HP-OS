# Ticketing

## Purpose and ownership

HP-OS owns each Site's operational buyer, order, ticket, admission, and sales-total records. LMNL is the first Site. See [ownership](../ownership.md) and the [first-release plan](https://github.com/fvckzest/HP-OS/issues/1).

## Settled behavior

The first release begins with new tickets after LMNL's current live event. The complete purchase, delivery, order-lookup, and admission journey is being designed in [ticket #8](https://github.com/fvckzest/HP-OS/issues/8). Current LMNL behavior is evidence, not a specification to copy.

## Data and states

Buyer records, orders, tickets, admission records, and sales totals belong to one Site, even when Sites share a payment connection. Their exact fields and lifecycle states are not yet settled. See [domain language](https://github.com/fvckzest/HP-OS/issues/7) and [ticket #8](https://github.com/fvckzest/HP-OS/issues/8).

## API links

The exact API contract will live in [docs/api.md](../api.md) after [ticket #10](https://github.com/fvckzest/HP-OS/issues/10).

## Decision links and evidence

See the [first-release plan](https://github.com/fvckzest/HP-OS/issues/1), [Site ownership decision](https://github.com/fvckzest/HP-OS/issues/3#issuecomment-5848567711), and [dated LMNL jobs inventory](../research/lmnl-event-ticketing-jobs.md). The inventory is evidence, not a settled HP-OS rule.
