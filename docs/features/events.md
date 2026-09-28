# Events

## Purpose and ownership

HP-OS owns each Site's operational Event records. LMNL is the first Site and owns staff CRUD and public presentation. Events are not shared between Sites. See [ownership](../ownership.md). The first-release jobs were selected in [ticket #6](https://github.com/fvckzest/HP-OS/issues/6); the journey rules below were settled in [ticket #8](https://github.com/fvckzest/HP-OS/issues/8).

## Setup and publication

- The first release covers new paid public and private Events after all current LMNL Events are complete. Cutover occurs with no active public sales; existing Events and their records remain in the existing system. Historical import is separate future work if needed. See the [release and cutover procedure](../release-and-cutover.md), agreed in [ticket #12](https://github.com/fvckzest/HP-OS/issues/12). Public and private Events both appear in the Site's public event list. A private Event offers an Access Request instead of public checkout. Free ticket issuance is deferred.
- Staff may save incomplete drafts. Publication requires a title, description, start and end dates and times with time zone, venue, and public or private visibility. The end must follow the start and may be days later for a multi-day Event.
- Public or private visibility can change while an Event is a draft but becomes fixed once published. This keeps the access rules stable after visitors see the Event or begin checkout; see [ticket #10](https://github.com/fvckzest/HP-OS/issues/10) and [Event editing rules](../api/api.md#draft-and-published-event-edits).
- Publication and sales are separate. A published Event can be visible before checkout opens. Price, capacity, and a scheduled sales opening and closing time are required before sales can open. The sales window may continue after Event start but must close no later than Event end.
- An Event becomes past automatically at its end time. Staff may archive an ended or canceled Event; archiving removes it from the current-event list but preserves its details, direct page, Orders, Tickets, and history. A Site may still show archived Events in a past-events view. Archiving does not change payment or admission status.

Separate publication and sales controls let Sites announce Events early without exposing an incomplete checkout. Preserving archived data keeps past Events and buyer records available.

## Sales and capacity

- Staff may stop new checkouts immediately and resume them while the Event is not canceled, its scheduled sales window is open, and capacity remains. A manual stop lets active checkouts finish.
- Checkout reserves the requested Ticket offering quantity without exceeding available capacity. The buyer has 15 minutes to start payment. At expiration, capacity releases only when no provider checkout can still take payment. The Site verifies and closes any existing checkout before release; processing or uncertain results keep their Reservation until verified. See [checkout expiry](../api/api.md#checkout-expiry-and-provider-verification).
- When an unpaid Reservation releases capacity, a sold-out Event becomes available automatically if the sales window is open and staff have not stopped sales.
- Capacity cannot be reduced below Tickets already admitted, issued Tickets still valid for Admission, and active Reservations. A fully refunded Ticket returns to sale capacity only if it was never admitted.
- A price edit affects only checkouts started afterward. Paid Orders and active checkouts retain their original quoted price.

These rules prevent overselling, release abandoned capacity, and keep purchase terms stable while staff make corrections.

## Event changes and cancellation

- After sales begin, staff may change the start or end date and time or venue. HP-OS notifies existing buyers, and Order pages show the current details.
- Each Event has a check-in opening time, defaulting to its start time; staff may set it earlier. Admission is available through the Event's end time. Scans outside that window create no Admission.
- Cancellation immediately stops new sales, ends buyer checkout, and prevents Ticket Admission. Reservations with a possible provider payment remain held until the Site verifies closure or the payment result; other unpaid Reservations release. HP-OS keeps the Event and purchase history. It emails buyers immediately and shows cancellation separately from refund status on their Order pages.
- Cancellation does not initiate a refund. Staff refund through the payment provider's dashboard; HP-OS reflects the resulting status. A charge confirmed after cancellation is recorded as paid and requiring a refund, with no usable Tickets, and alerts staff.

Notifying buyers of changed arrival details and cancellation keeps the public journey accurate. Keeping refund status separate avoids implying money was returned before the provider confirms it.

HP-OS durably queues the required notifications; the Site backend sends them using its own credentials and reports outcomes. This keeps credentials outside HP-OS while preserving notification recovery and visibility, as decided in [ticket #10](https://github.com/fvckzest/HP-OS/issues/10). See [notification jobs](../api/api.md#notification-jobs).

## Presentation and API boundaries

Featured and home-page selection remain LMNL controls. Manual event-page and checkout-link overrides, arbitrary custom traits, and the Square test-item action are outside normal first-release Event setup. See [ticket #6](https://github.com/fvckzest/HP-OS/issues/6).

An Event belongs to one Site and has one priced Ticket offering in the first release. The offering is the sale option and capacity, not an issued Ticket. See the [domain glossary](../../CONTEXT.md). The Site API must keep archived Event details retrievable for past-event presentation; exact operations and payloads belong to [ticket #10](https://github.com/fvckzest/HP-OS/issues/10) and [docs/api/api.md](../api/api.md).

The Ticket offering may optionally be associated with an existing payment-provider resource on a payment connection. HP-OS remains authoritative for price and capacity, and this association does not enable per-Event provider selection. Optional association supports checkout without requiring a preexisting catalog resource. Automatic provider catalog creation is deferred beyond the first release to avoid adding a catalog synchronization workflow. See the [decision in ticket #10](https://github.com/fvckzest/HP-OS/issues/10) and [offering provider mapping](../api/api.md#offering-provider-mapping) for the API boundary.
