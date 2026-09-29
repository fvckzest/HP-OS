# Organization and Site ownership

## Purpose

This file holds boundaries shared by events, ticketing, and later features. The first-release decision was recorded in [ticket #3](https://github.com/fvckzest/HP-OS/issues/3#issuecomment-5848567711). Keeping it here avoids repeating the same ownership rules in every feature file.

## Settled rules

- A customer organization owns one or more Sites. Each Site belongs to exactly one organization. Moving a Site between organizations is outside the first release.
- Each Site owns its events, buyer records, orders, tickets, admission records, and sales totals. Buyer and order records are not shared across Sites. Combined organization reporting is deferred.
- Each Site backend has its own HP-OS API key. Keys have 256 bits of random secret material, are stored in HP-OS only as SHA-256 hashes, and can be issued, rotated, or revoked with the operator command described in [ticket #24](https://github.com/fvckzest/HP-OS/issues/24). The Site backend keeps the plaintext key in its server environment; it is never sent to a browser. Each Site alone defines and enforces staff permissions, including limited door access, and authorizes staff actions before calling HP-OS. HP-OS authenticates the server-to-server call, enforces the key's Site boundary and operational business rules, and does not evaluate individual staff roles. This keeps staff access policy with the Site that authenticates staff; see [ticket #10](https://github.com/fvckzest/HP-OS/issues/10) and [Site authorization](api/api.md#site-authorization). HP-OS has no staff login or organization administrator role in the first release. A person overseeing multiple Sites uses the relevant Site interfaces.
- The organization owns payment connections. It may explicitly assign one connection to several Sites or use separate connections. Sharing a connection does not change which Site owns an order or ticket.
- The customer is the seller for ticket sales. HP-OS receives a platform fee through the payment provider. One fee agreement belongs to the organization and applies across its Sites.
- HP-OS operators manually set up organizations, Sites, connection assignments, API keys, and fee-term validation status in the first release. Customers use Site CRUD interfaces for daily operations. The current operator command marks fee terms and provider-account eligibility as `pending_validation`; it does not store invented fee values or claim account eligibility. The Site configuration API exposes only the connection metadata specified by the existing contract. This preserves the unresolved boundaries recorded in [tickets #22](https://github.com/fvckzest/HP-OS/issues/22) and [#24](https://github.com/fvckzest/HP-OS/issues/24).

These boundaries keep operational records Site-specific while allowing an organization to share a payment connection and fee agreement across its Sites. See the [decision discussion](https://github.com/fvckzest/HP-OS/issues/3#issuecomment-5848567711) for context.

## External service credentials

HP-OS retains no external service credentials supplied by a Site or customer organization, including payment-provider credentials, email-provider credentials, or Apple Wallet signing certificates and private keys. Site backends hold these credentials and execute credential-dependent integrations. HP-OS retains operational records and non-secret integration references. This keeps external service secret custody outside HP-OS, as decided in [ticket #10](https://github.com/fvckzest/HP-OS/issues/10). HP-OS authentication of its own Site API keys remains the agreed server-to-server access boundary.

## Data separation and payment execution

The following rules were agreed in [ticket #9](https://github.com/fvckzest/HP-OS/issues/9).

- HP-OS derives the Site from the authenticated API key and checks record ownership on every operation. A Site key cannot read or change another Site's records, even with an exact record ID or a shared organization or payment connection. Related records must belong to the same Site.
- Payment-provider credentials remain in each Site backend's server environment or secret store, not committed source files, the browser, or HP-OS. HP-OS stores connection identities, organization ownership, and explicit Site assignments without provider secrets.
- Each Site has one active payment connection for new Orders in the first release. An organization may assign the same connection to several Sites or use separate connections. Per-Event provider selection is deferred.
- HP-OS operators manage connection assignments and the organization's platform-fee terms. Site keys may read the configuration needed for payment execution but cannot change these settings. The provider splits the platform fee to LMNL; the customer organization remains the seller.
- HP-OS creates Orders and Reservations and supplies authoritative payment totals, currency, and platform-fee amounts. The Site backend creates provider checkout using those values and its own credentials.
- Each payment attempt is recorded against exactly one Order, Site, and provider connection, with its provider checkout and payment references. The Site records available checkout references with HP-OS before opening checkout to the buyer and reports subsequent payment references against that attempt. A shared connection or buyer email alone cannot identify the owning Order or Site.
- The Site backend receives and verifies provider notifications, checks unresolved payments with the provider, and retries reporting verified payment and refund results to HP-OS using its Site key. This makes the Site backend a trusted payment-verification component: HP-OS has no provider credentials to independently query the payment.
- HP-OS checks the reported Site, connection, payment references, amount, and currency against the recorded attempt before applying a result. Repeated reports cannot issue duplicate Tickets. Conflicting reports are retained for investigation, block automatic fulfillment, and are exposed to staff; an uncertain payment keeps its Reservation until resolved. Using authoritative amounts and recorded references should prevent these conflicts during normal operation.
- A connection change affects only new Orders. Existing Orders retain their original connection and references; their Site backend must remain able to verify payments and refunds through that connection.

These rules preserve Site ownership while keeping payment credentials and provider calls on the Site backend. HP-OS remains authoritative for Orders, Reservations, Tickets, Admissions, and sales totals. See the [ticketing recovery rules](features/ticketing.md#public-checkout-and-payment).

## Pending details

Provider selection, account eligibility, and the concrete platform-fee setup still require validation against the [provider research](research/payment-email-provider-constraints.md). The rules above assign responsibilities; they do not prove provider integration or fee settlement. Exact API-key behavior, payment-report operations, fields, and errors are defined in the [API contract](api/api.md), as agreed during [ticket #10](https://github.com/fvckzest/HP-OS/issues/10).
