# LMNL release proof and cutover

Settled guidance from [HP-OS ticket #12](https://github.com/fvckzest/HP-OS/issues/12). This defines required evidence; it does not claim that any checks have passed or that HP-OS is implemented.

## Scope and release rule

LMNL is the only Site in this release proof. MASS is outside scope.

Every required check must pass. A failure blocks release until it is fixed and retested. Record the environment, application revision, scenario, expected result, actual result, and supporting evidence for each check. Keep credentials and buyer access secrets out of evidence. Automated tests support the proof but do not replace complete journeys through LMNL, HP-OS, and the relevant external services.

The sequence is:

1. Prove the required behavior locally with test data and test payments. Prove the complete public single-ticket journey before extending it to public multi-ticket purchase.
2. Prove the complete hosted LMNL integration with test payments and actual email and Wallet integrations. Verify hosted database migrations and connectivity, provider callbacks, and both HP-OS and Site scheduled processing. Local results do not establish hosted readiness.
3. After all preceding required checks pass, make a controlled real purchase and refund. Verify the actual payment amount and currency, payment reporting, Ticket issuance, delivery, Order access, admission, refund reporting, Ticket invalidation, and totals. Verify actual provider and platform fee reporting and settlement; pending information must not appear as confirmed or zero. Public sales remain closed during this controlled check.
4. Obtain the user's explicit approval before opening the first HP-OS Event's sales. Passing checks does not grant that approval automatically.

The real-payment check is the final integration check, after the system has demonstrated correct behavior with test payments. Required real-payment or settlement results that remain unresolved block release.

## Required proof

The detailed expected behavior remains defined in [Events](features/events.md), [Ticketing](features/ticketing.md), and the [API contract](api/api.md).

| Area | Required evidence |
| --- | --- |
| Event setup | Staff create and publish public and private Events; both appear publicly. Publication, scheduled sales, manual stop/resume, capacity, and check-in times enforce the documented rules. |
| Public single-ticket purchase | The provider total matches the authoritative quote. Verified payment produces one Ticket, an initial email, an Order page, and a separate Ticket QR page. Returning from payment alone does not issue a Ticket. |
| Public multi-ticket purchase | After the single-ticket journey passes, an Order can purchase one to eight Tickets subject to availability. Its complete Ticket set is issued once, each Ticket is separately shareable and usable, and concurrent checkouts do not oversell capacity. |
| Private purchase | Unapproved requests cannot pay. Approval sends a link without reserving capacity; it permits one successful one-ticket purchase, retains the approved attendee, and cannot be reused for another successful purchase. Rejection, undoing approval, reapproval, retries, and sold-out outcomes follow the contract. |
| Checkout and payment recovery | Exercise failed and delayed payment, expiry, duplicate reports, conflicting reports, and interrupted processing. Capacity stays held while payment remains possible or uncertain and releases only after the required verification. Buyers see accurate status; staff can find unresolved work. |
| Issuance and delivery recovery | Deliberately fail Ticket issuance and email delivery. A paid Order remains paid; issuance recovers without duplicates, email failure does not invalidate Tickets, and staff retry/resend actions work. Scheduled recovery continues without visitor requests. |
| Buyer access and correction | Email recovery sends access to the current delivery address without exposing Orders from an email entry alone. A verified delivery-address correction replaces access links, preserves the original purchase identity and existing QR codes, and resends to the corrected address. |
| Admission | Phone-camera scanning and manual lookup each admit an eligible Ticket once. Two door devices attempting the same Ticket nearly simultaneously produce exactly one Admission. Invalid, repeated, early, late, canceled, and fully refunded Tickets create no Admission. Lost HP-OS connectivity records no Admission. Door staff have only their intended permissions. |
| Apple Wallet | Add a signed pass to an actual supported device. Verify Event time and venue updates, used status, and void status after cancellation or full refund. Live Admission remains authoritative while device updates are delayed. Site processing retries failed update work. |
| Event changes, cancellation, and refunds | Changed arrival details reach buyers and Order pages. Cancellation stops checkout and Admission and notifies buyers without claiming a refund occurred. Verify a payment confirmed after cancellation creates no usable Tickets and requires staff refund. Full and partial refunds, capacity restoration, and retained Admission history follow the contract. |
| Totals and fees | Gross paid sales, refunds, net sales, issued/valid/admitted counts, provider fees, and platform fees agree with recorded outcomes. Missing fee confirmation stays pending; fee returns require their own confirmation. |
| Permissions and isolation | Unauthorized operations fail, and Site credentials cannot access another Site's records. Use synthetic test records for isolation checks; MASS is not a release target. Site-owned service credentials remain outside HP-OS. |
| Hosted operation | Reviewed migrations apply successfully. Hosted provider callbacks and scheduled HP-OS and LMNL workers execute, recover after interruption, and tolerate overlapping attempts without duplicate business effects. Staff can identify failed or unresolved work. |

## Cutover procedure

1. Finish all current LMNL Events using the existing system for their sales, Orders, Tickets, and Admission. Do not move these Events into HP-OS.
2. Prepare and verify the hosted environment and LMNL integration without active public sales. Establish the exact production configuration to switch and how to restore the previous configuration before new sales begin.
3. During a period with no active sales, switch LMNL to the verified HP-OS integration. Keep public sales closed while checking the production configuration and completing the controlled real-payment check.
4. Review the completed evidence and unresolved work. Any failed or unresolved required check keeps sales closed.
5. Obtain the user's explicit approval, then open sales for the first new HP-OS Event.

Existing Events and their historical records remain in the existing system. Preserve the access needed to those records and existing links. Historical import is separate future work if it becomes necessary; it is not a cutover requirement.

If cutover verification fails before new sales open, keep sales closed and fix the problem or restore the previous configuration. If a serious problem appears after sales open, stop new checkouts and preserve existing Order access, Tickets, and Admission wherever those functions remain operational. Keep paid HP-OS records together rather than moving an active Event between systems; repairing service and resolving outstanding payments must preserve those records.

## Evidence status

No release checks are marked passed by this planning document. Implementation, test results, hosted verification, the controlled real-payment result, and final approval must be recorded as they occur.
