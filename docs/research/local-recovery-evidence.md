# Local recovery and private-access evidence

This record defines the evidence boundary for issues [#45](https://github.com/fvckzest/HP-OS/issues/45), [#46](https://github.com/fvckzest/HP-OS/issues/46), and [#47](https://github.com/fvckzest/HP-OS/issues/47). It is a local implementation record, not release or cutover approval.

## Local evidence

Verified on October 6, 2026, against the dedicated local PostgreSQL database at `127.0.0.1:54322/postgres`, using loopback HTTP and synthetic Site/provider reports. The tested source matches implementation commit `9bf2a24`; the checks ran on that source tree before it was committed. The following evidence-only documentation update changes no application code.

| Command | Scope | Result |
| --- | --- | --- |
| `pnpm verify:recovery` | Overlapping workers, lost reports, uncertain capacity, issuance, stale claims, correction/recovery, cancellation, late payment, refunds, and totals. | Passed; unknown outcomes remained unresolved and repeated recovery produced no duplicate Tickets or dispatch effects. |
| `pnpm verify:private-access` | Submission, decision races, link replacement, separate payer/attendee, concurrent checkout, withdrawal, sold-out handling, Admission, refund, and cleanup. | Passed; one approval produced one purchase and retained its consumption through a conflicted state and refund. |
| `pnpm verify:events` | Existing public checkout, payment, issuance, notification, refund, and Admission behavior. | Passed. |
| `pnpm verify:notifications` | Claims, fencing, bounded scheduling, Site isolation, and simulated delivery reporting. | Passed. |
| `pnpm verify:fees` | Fee confirmation, missing information, conflicts, currencies, and consistent Ticket totals. | Passed. |
| `pnpm verify:historical-connections` | Frozen Order connections/mappings, restart visibility, and Site isolation. | Passed. |
| `pnpm test` | Local schema, disabled generated Data API, Site credentials, request limits, and permission/isolation checks. | Passed. |
| `pnpm typecheck` | TypeScript API and server type safety. | Passed. |
| `pnpm exec next build --webpack` | Production compilation of the Next.js application. | Passed. |
| All version-controlled migration SQL files, in order, in a temporary empty local database | Fresh installation of all 24 migrations, including private approval constraints. | Passed; the temporary database was removed afterward. |
| `git diff --check` | Patch whitespace validation. | Passed. |

The verifier assertions encode the expected outcomes and fail with bounded diagnostics when an outcome differs. Both new verifiers reported their local verification as passed. They retain unknown provider or dispatch outcomes as unresolved work rather than treating them as success. These results establish local HP-OS behavior only.

## Issue completion scope

[PR #98](https://github.com/fvckzest/HP-OS/pull/98) delivers the following HP-OS scope. Issue closure follows the [repository-wide deferral policy](../release-and-cutover.md#repository-wide-deferral-and-issue-closure); it does not certify the complete LMNL recovery stage or external private-purchase journey.

| Issue | Completed HP-OS scope | Later cutover evidence |
| --- | --- | --- |
| #45 | Combined recovery verification through local PostgreSQL and HTTP, including interrupted and overlapping processing, retained uncertainty, issuance, notification fencing, buyer correction/recovery, cancellation, refunds, and totals. | Actual LMNL scheduled workers and durable provider reporting, verified provider closure, hosted processing, and actual email delivery. |
| #46 | Private Access Request submission, Site-scoped reads, version-guarded decisions and correction, attendee history, replaceable approval links, and durable approval notification work without capacity reservation. | LMNL request and staff interfaces, Site staff permission enforcement, and actual approval email execution. |
| #47 | Approval-bound one-Ticket checkout, separate attendee and payer snapshots, one active or unresolved Order, permanent purchase consumption, safe withdrawal, and existing issuance/Admission/refund behavior. | The complete LMNL approval-to-purchase journey through actual provider checkout, email, and supported devices. |

## Behavior covered by the HP-OS boundary

- Approval requests are Site-scoped and identify the intended attendee by name and email. Repeated submission with one idempotency key replays the original request; a new key creates an independent request, including when attendee details match another request.
- Approval and rejection are version-guarded decisions. Approval creates the durable approval notification work and an approval token without reserving capacity. Undoing an unpaid approval invalidates that token and fences its unpaid checkout. Corrections follow the pending and unresolved-payment rules in the API contract.
- Approval-link lookup returns the approved attendee separately from purchaser details. Private checkout first creates a one-Ticket quote with the approval token, then creates the Order with the same token and purchaser details. The Order carries the approved attendee snapshot, permits one active unpaid or unresolved checkout per approval, and cannot be created again after a successful purchase. Retries use the existing Order.
- Recovery fixtures include whole-second Event times. API serializers retain the explicit RFC 3339 `Z` or numeric offset in those values, so `tickets_ready` notification validation accepts valid timestamps at the issuance-recovery boundary.
- HP-OS retains uncertain payment, issuance, delivery, refund, and notification work for later Site verification. Local checks prove state transitions and idempotency at the HP-OS boundary only.

## Deferred evidence

The repository-wide development boundary defers LMNL implementation and integration, hosted workers, real provider callbacks and payments, actual mailbox delivery, Apple Wallet signing and device behavior, and production cutover proof until the user explicitly declares the cutover window. Local PostgreSQL or synthetic Site checks do not establish those facts. The required later scenarios and their ordering are recorded in the [release and cutover procedure](../release-and-cutover.md).

In particular, this record does not certify approval email delivery, a real private payment, provider checkout closure, Wallet pass installation or updates, or unattended recovery across a live LMNL worker. Those checks remain release evidence even when the HP-OS implementation and its local checks are complete.
