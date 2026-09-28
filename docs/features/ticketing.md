# Ticketing

## Purpose and ownership

HP-OS owns each Site's Buyers, Orders, Reservations, Tickets, Admissions, and sales totals. LMNL is the first Site. The first-release jobs were selected in [ticket #6](https://github.com/fvckzest/HP-OS/issues/6); the journey rules below were settled in [ticket #8](https://github.com/fvckzest/HP-OS/issues/8). See [ownership](../ownership.md) and the [domain glossary](../../CONTEXT.md).

## Private Access Requests

- A private Event appears publicly with an Access Request form. An approved request permits one paid Ticket; it is permission to begin checkout, not an Order or Reservation.
- Each Access Request requires the intended attendee's name and email so admin users can vet whose admission they are approving, even when another person will pay. Checkout separately collects the purchaser's details, and the Ticket retains its association with the approved attendee. Public checkout continues without individual attendee details. See [ticket #10](https://github.com/fvckzest/HP-OS/issues/10) and [Access Request operations](../api/api.md#access-request-operations).
- Multiple independent requests for one Event may use identical attendee names and emails. Each requires its own approval and permits one paid Ticket; private multi-ticket Orders remain deferred. This keeps repeated requests simple while maintaining approval per request. See [ticket #10](https://github.com/fvckzest/HP-OS/issues/10).
- Approval emails the guest a checkout link but does not hold capacity. The link works until sales close, permits payment retries, and can produce only one successful purchase. If capacity runs out first, it shows a sold-out outcome.
- Rejection sends no email. Staff may undo either decision and reconsider the request. Undoing approval before payment disables its link and ends an unpaid checkout; approving again sends a new link. After payment, undoing the request decision does not change the paid Order or Ticket.
- Correcting attendee details on an approved, unpaid request exceptionally requires undoing approval and approving the corrected request again. Normal checkout carries the approved attendee details forward without collecting them again; purchaser-detail changes do not alter the approved attendee. This preserves the vetted identity without adding a routine correction step; see [ticket #10](https://github.com/fvckzest/HP-OS/issues/10).

This keeps the private approval queue separate from public purchases and prevents unused approvals from consuming capacity.

## Public checkout and payment

- Public checkout permits one to eight Tickets per Order, subject to availability. Checkout collects the Buyer's real name and email. Before payment opens, the Site shows the full buyer-facing total, including applicable fees and tax, in the correct currency. HP-OS supplies the authoritative quote; the provider must show the same total.
- An Order starts when checkout starts and reserves its requested quantity. The buyer has 15 minutes to start payment. At the deadline, the Site must verify that an existing provider checkout can no longer take payment before HP-OS releases the Reservation. Processing or uncertain outcomes keep capacity held until verified; an Order with no payment attempt can expire directly. See [checkout expiry](../api/api.md#checkout-expiry-and-provider-verification).
- A failed payment can be retried from the same Order while its 15-minute window remains open. After expiration, the buyer starts a new checkout if capacity remains. If the Site verifies that no provider checkout can take payment, HP-OS releases the Reservation and shows a temporary error with a retry option.
- Returning from the payment page shows a payment-confirmation state and Order link. It does not prove payment or expose Tickets. The Site backend verifies provider notifications, checks unresolved payments with the provider, and retries reporting verified results to HP-OS. HP-OS validates reports against the recorded payment attempt, tracks unresolved Orders, and exposes problems to staff. An unknown result keeps its Reservation until staff verify the provider record and resolve it. These responsibilities were clarified in [ticket #9](https://github.com/fvckzest/HP-OS/issues/9); see [payment execution and ownership](../ownership.md#data-separation-and-payment-execution).
- A confirmed payment with failed Ticket issuance leaves the Order paid and awaiting Tickets. HP-OS issues a multi-ticket Order's complete set together, retries safely without duplicates, and alerts staff if recovery remains unresolved. Staff can use a guarded retry action.

These rules prevent overselling and presenting an unpaid or incomplete Order as a successful purchase.

## Delivery, Order access, and buyer correction

- The initial ticket email is the normal access path. It contains one hard-to-guess link that opens the Order page directly without login or an emailed code. That page contains all Tickets; each Ticket has its own QR and admission-status page and can be shared separately. Anyone given the Order link can access every Ticket in it.
- A group can show all Tickets from one Order page; door staff scan each QR in turn. A buyer who loses the email can request a time-limited Order link sent to the current delivery email. Entering an email address alone never reveals an Order.
- Ticket issuance and validity do not depend on email delivery. HP-OS durably queues and tracks required notification work, including retry work for failed delivery; the Site backend sends emails using its own credentials and reports outcomes. Staff can request a resend. The Order page remains available after issuance. This execution boundary was settled in [ticket #10](https://github.com/fvckzest/HP-OS/issues/10); see [notification jobs](../api/api.md#notification-jobs).
- After verifying the purchase, authorized staff can correct a mistyped delivery email. HP-OS preserves the original checkout name and email, invalidates old Order and individual Ticket links, issues replacements, and resends to the corrected address. Previously shared Ticket links must be shared again. Future Order lookup uses only the corrected email, and the Order joins that Site's Buyer record for the corrected address.
- Delivery-email correction preserves admission QR codes and existing Wallet passes. Previously captured screenshots and saved passes still work while the Ticket is eligible; one successful Admission per Ticket remains enforced. Wallet passes are not voided solely for email correction and still reflect cancellation, full refunds, and used status. Normal resends and recovery also preserve QR codes. This keeps existing QR presentations usable, as decided in [ticket #10](https://github.com/fvckzest/HP-OS/issues/10).
- Repeat Orders with the same purchase email on a Site associate with one Buyer. Each Order keeps its own checkout name and email; Sites never share Buyer records.

Separating access links, delivery state, and historical checkout details supports buyer recovery without rewriting purchase history.

## Admission and Wallet

- Door staff have limited check-in access without full Event administration permission; the Site authorizes them. Online phone-camera scanning and manual lookup enforce one successful Admission per Ticket, including at multi-day Events. Invalid, already-admitted, early, late, canceled, and fully refunded Tickets do not create Admissions.
- If QR scanning fails, staff can find the Order by reference number or purchase email, review Event and Ticket status, select one unused Ticket, and confirm its Admission. If the device loses HP-OS connectivity, it shows unable to verify and records no Admission.
- Admission is allowed from the Event's check-in opening time through its end time. Simultaneous attempts against one Ticket must produce exactly one successful Admission.
- Each Ticket can be added to Apple Wallet. An updatable pass receives current Event time and venue, shows used status after Admission, and becomes void after cancellation or a full refund. [Apple supports pass updates](https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes) and a [voided field](https://developer.apple.com/documentation/walletpasses/pass). Device updates may arrive later, so the live HP-OS admission result remains authoritative.
- The Site backend generates and signs Wallet passes and holds the signing credentials. HP-OS retains no Site or organization service credentials and supplies authoritative operational data instead. This keeps credential custody on the Site; see [ticket #10](https://github.com/fvckzest/HP-OS/issues/10) and [external service credentials](../ownership.md#external-service-credentials).
- HP-OS durably queues required Wallet update work for the Site backend to execute and report, alongside email notifications. See [ticket #10](https://github.com/fvckzest/HP-OS/issues/10) and [notification jobs](../api/api.md#notification-jobs).
- Wallet templates, artwork, logos, images, layout, and presentation text belong to the Site. The Site combines them with current HP-OS Event and Ticket data and regenerates passes when either operational data or its own presentation changes. This keeps presentation Site-owned; see [ticket #10](https://github.com/fvckzest/HP-OS/issues/10) and [Wallet generation](../api/api.md#apple-wallet-generation).

## Refunds and event totals

- Staff perform refunds in the provider dashboard; the Site backend verifies and reports the refund so HP-OS can update Order and Ticket status. Reporting retries also cover refunds for Orders on previous payment connections. See [ticket #9](https://github.com/fvckzest/HP-OS/issues/9). Event cancellation does not itself refund. A charge confirmed after cancellation is paid but requires staff refund, alerts staff, and creates no usable Tickets.
- A full Order refund makes its Tickets unusable for future Admission while retaining Order, Ticket, and prior Admission history. An unadmitted refunded Ticket returns to sale capacity. A partial refund changes money status but does not automatically revoke Tickets.
- The Site API exposes gross paid sales, refunded amount, and net sales; net is gross less refunds. It also exposes Tickets issued, valid, and admitted as separate counts. Valid counts exclude canceled and fully refunded Tickets, but do not depend on the check-in clock and can overlap admitted counts; immediate entry eligibility is reported separately as `can_admit`. An issued but fully refunded Ticket remains in issued history but no longer counts as valid.
- Event totals also report provider processing fees and LMNL platform fees separately so admin users can see each deduction. Fees use actual provider-confirmed amounts reported by the Site backend; missing fee information is explicitly pending and cannot appear as zero or as a confirmed estimate. The platform fee expected at checkout is separate from confirmation of what LMNL received. Net sales retains its definition above. This reporting scope and confirmation boundary were settled in [ticket #10](https://github.com/fvckzest/HP-OS/issues/10); exact fee fields and confirmation behavior are defined in the [API contract](../api/api.md#event-totals-response).
- Each fee category shows charged amounts, confirmed returns or credits, and net fees separately. Net fees are charged amounts less returns. A buyer refund does not imply a fee return without separate provider confirmation. This preserves fee history and shows the retained amount; see [ticket #10](https://github.com/fvckzest/HP-OS/issues/10).
- Staff can inspect Event ticket holders, each Order's payment and issuance status, and these basic totals. Provider settlement information remains the accounting source.

These separate totals show both historical sales and current entry rights without implying a separate reconciliation report.

## Release proof

[Ticket #12](https://github.com/fvckzest/HP-OS/issues/12) defines the [LMNL release checklist and cutover procedure](../release-and-cutover.md). Local and hosted tests precede a controlled real purchase and refund. Every required check must pass, and the user must explicitly approve opening sales. Cutover happens after all current Events are complete, with no active public sales; historical records remain in the existing system.

Before the first release, prove a complete single-ticket purchase, then a multi-ticket purchase, using provider-confirmed payment, the initial ticket email, Order page, separate QR pages, one successful Admission per Ticket, and an already-admitted repeat scan. Also prove private Access Request approval, email, one-ticket purchase, and prevention of a second successful use of the approval link.

Deliberately exercise delayed payment confirmation, Ticket issuance failure, and ticket-email failure; verify accurate buyer status, automatic recovery, and staff visibility for unresolved work. Two door devices must attempt the same Ticket nearly simultaneously and produce exactly one Admission. Cancel a sold Event, confirm buyer notification and blocked Admission, then process a provider refund and verify Order status and Site API totals. These are end-to-end checks; isolated quantity support or unit tests do not prove the journey. See [ticket #8](https://github.com/fvckzest/HP-OS/issues/8).

## Deferred controls and API contract

Free Tickets, private multi-ticket checkout, bulk holder email, CSV export, refunds from LMNL, and a separate payment reconciliation report are deferred. See [ticket #6](https://github.com/fvckzest/HP-OS/issues/6). Exact API operations, payloads, permissions, and errors belong to [ticket #10](https://github.com/fvckzest/HP-OS/issues/10) and [docs/api/api.md](../api/api.md).
