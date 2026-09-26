# Events

## Purpose and ownership

HP-OS owns each Site's operational event records. LMNL is the first Site and provides the staff CRUD interface and public presentation. A Site's events are not shared with another Site. See [ownership](../ownership.md) and the [first-release plan](https://github.com/fvckzest/HP-OS/issues/1).

## Settled behavior

The first release begins with new events after LMNL's current live event. It supports paid public and private events; free ticket issuance is deferred. Both event types appear in LMNL's public event list. A private event offers an Access Request, and staff approval is required before the guest can enter paid checkout.

LMNL staff can create and edit events, archive inactive events instead of permanently deleting their history, and cancel an event after sales begin. Staff can correct or update an event after sales start; the safeguards for changes affecting buyers and the cancellation procedure belong to [ticket #8](https://github.com/fvckzest/HP-OS/issues/8).

Featured and home-page selection remain LMNL presentation controls. For HP-OS ticketed events, manual event-page or checkout-link overrides and arbitrary custom traits are deferred. The Square test-item action is removed from normal staff event setup. These choices keep the operational event and purchase path consistent while retaining useful Site presentation controls. See the [first-release jobs decision](https://github.com/fvckzest/HP-OS/issues/6).

## Data and states

An Event belongs to one Site and has exactly one priced Ticket offering in the first release. The offering represents what is sold and its available quantity; it is distinct from both the Event and each issued Ticket. See the [domain glossary](../../CONTEXT.md) and [decision in ticket #7](https://github.com/fvckzest/HP-OS/issues/7#issuecomment-5848989424). Exact fields, publication rules, sales rules, and lifecycle states remain for [ticket #8](https://github.com/fvckzest/HP-OS/issues/8).

## API links

The exact API contract will live in [docs/api.md](../api.md) after [ticket #10](https://github.com/fvckzest/HP-OS/issues/10).

## Decision links and evidence

See the [first-release plan](https://github.com/fvckzest/HP-OS/issues/1), [Site ownership decision](https://github.com/fvckzest/HP-OS/issues/3#issuecomment-5848567711), [first-release jobs decision](https://github.com/fvckzest/HP-OS/issues/6), and [dated LMNL jobs inventory](../research/lmnl-event-ticketing-jobs.md). The inventory is evidence, not a settled HP-OS rule.
