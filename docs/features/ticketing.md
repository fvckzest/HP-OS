# Ticketing

## Purpose and ownership

HP-OS owns each Site's operational buyer, order, ticket, admission, and sales-total records. LMNL is the first Site. See [ownership](../ownership.md) and the [first-release plan](https://github.com/fvckzest/HP-OS/issues/1).

## Settled behavior

The first release begins with new tickets after LMNL's current live event. Public checkout must first prove a complete single-ticket path; public multi-ticket purchasing must then work before release. An approved private Access Request initially allows one paid ticket. Checkout requires the buyer's real name and email, rather than a placeholder identity.

Buyers can retrieve an order later, open each ticket's separate QR and admission-status page, and add a ticket to Apple Wallet. Staff can view an event's ticket holders, inspect each order's payment and ticket-issuance status, resend ticket links, safely retry issuance for a paid order missing tickets, and view basic event totals: tickets sold, tickets admitted, and paid sales amount.

Door staff have limited check-in access without full event administration permission. Online phone-camera scanning and manual ticket lookup both enforce one-time admission and show invalid or already-used outcomes. LMNL authorizes its door staff; see [ownership](../ownership.md).

Bulk ticket-holder email, CSV export, refunds from LMNL, and a separate payment reconciliation report are deferred. Refunds may be performed in the payment provider's dashboard, but HP-OS must reflect the resulting order and ticket status. Staff use provider settlement information for accounting. These choices preserve the purchase, support, and admission jobs without copying every existing control. See the [first-release jobs decision](https://github.com/fvckzest/HP-OS/issues/6).

The complete purchase, delivery, order-lookup, cancellation, refund-status, and admission rules, including failure recovery and the proof required for single- and multi-ticket checkout, belong to [ticket #8](https://github.com/fvckzest/HP-OS/issues/8). Current LMNL behavior is evidence, not a specification to copy.

## Data and states

Buyer records, Orders, Tickets, Admissions, and sales totals belong to one Site, even when Sites share a payment connection. A Buyer is reusable across that person's Orders on the same Site. Each Order retains the name and email used for that purchase, begins when checkout starts, and concerns one Event. A private Access Request is permission to begin checkout, not an Order.

An Order may have no issued Tickets before payment. A paid Order can issue multiple independently usable Tickets. Each Ticket can have at most one successful Admission. Individual attendee identity is not required, so the Buyer need not be the person who uses every Ticket.

See the [domain glossary](../../CONTEXT.md) and [decision in ticket #7](https://github.com/fvckzest/HP-OS/issues/7#issuecomment-5848989424). Exact fields, state transitions, payment outcomes, and recovery rules remain for [ticket #8](https://github.com/fvckzest/HP-OS/issues/8).

## API links

The exact API contract will live in [docs/api.md](../api.md) after [ticket #10](https://github.com/fvckzest/HP-OS/issues/10).

## Decision links and evidence

See the [first-release plan](https://github.com/fvckzest/HP-OS/issues/1), [Site ownership decision](https://github.com/fvckzest/HP-OS/issues/3#issuecomment-5848567711), [first-release jobs decision](https://github.com/fvckzest/HP-OS/issues/6), and [dated LMNL jobs inventory](../research/lmnl-event-ticketing-jobs.md). The inventory is evidence, not a settled HP-OS rule.
