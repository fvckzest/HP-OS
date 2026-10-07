# Local recovery and private-access evidence

This record defines the evidence boundary for issues [#45](https://github.com/fvckzest/HP-OS/issues/45), [#46](https://github.com/fvckzest/HP-OS/issues/46), and [#47](https://github.com/fvckzest/HP-OS/issues/47). It is a local implementation record, not release or cutover approval.

## Local evidence

The implementation is exercised through the normal HTTP API against the repository's local PostgreSQL schema. The verification scripts are:

| Command | Scope | Result |
| --- | --- | --- |
| `pnpm verify:recovery` | Durable recovery state, guarded retries, notification claims, uncertain outcomes, and restart-safe processing for the HP-OS boundary. | Passed in the root-coordinated local working tree; final tested revision remains to be recorded. |
| `pnpm verify:private-access` | Private Event Access Request submission, approval decisions, approval-link lookup, private checkout, approved-attendee preservation, and one-purchase fencing. | Passed in the root-coordinated local working tree; final tested revision remains to be recorded. |
| `pnpm verify:events` | Event publication, arrival-change notification fan-out, and related event-boundary behavior. | Passed in the root-coordinated local working tree; final tested revision remains to be recorded. |
| `pnpm typecheck` | TypeScript API and server type safety. | Passed in the root-coordinated local working tree; final tested revision remains to be recorded. |
| `pnpm build` | Production compilation of the Next.js application. | Record the root agent's result here. |

The evidence should record the tested revision, local database environment, scenario, expected result, actual result, and command output. A failed or incomplete scenario remains visible as unresolved work; an unknown provider or dispatch outcome must not be treated as success.

## Behavior covered by the HP-OS boundary

- Approval requests are Site-scoped and identify the intended attendee by name and email. Repeated submission with one idempotency key replays the original request; a new key creates an independent request, including when attendee details match another request.
- Approval and rejection are version-guarded decisions. Approval creates the durable approval notification work and an approval token without reserving capacity. Undoing an unpaid approval invalidates that token and fences its unpaid checkout. Corrections follow the pending and unresolved-payment rules in the API contract.
- Approval-link lookup returns the approved attendee separately from purchaser details. Private checkout first creates a one-Ticket quote with the approval token, then creates the Order with the same token and purchaser details. The Order carries the approved attendee snapshot, permits one active unpaid or unresolved checkout per approval, and cannot be created again after a successful purchase. Retries use the existing Order.
- Recovery fixtures include whole-second Event times. API serializers retain the explicit RFC 3339 `Z` or numeric offset in those values, so `tickets_ready` notification validation accepts valid timestamps at the issuance-recovery boundary.
- HP-OS retains uncertain payment, issuance, delivery, refund, and notification work for later Site verification. Local checks prove state transitions and idempotency at the HP-OS boundary only.

## Deferred evidence

The repository-wide development boundary defers LMNL implementation and integration, hosted workers, real provider callbacks and payments, actual mailbox delivery, Apple Wallet signing and device behavior, and production cutover proof until the user explicitly declares the cutover window. Local PostgreSQL or synthetic Site checks do not establish those facts. The required later scenarios and their ordering are recorded in the [release and cutover procedure](../release-and-cutover.md).

In particular, this record does not certify approval email delivery, a real private payment, provider checkout closure, Wallet pass installation or updates, or unattended recovery across a live LMNL worker. Those checks remain release evidence even when the HP-OS implementation and its local checks are complete.
