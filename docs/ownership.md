# Organization and Site ownership

## Purpose

This file holds boundaries shared by events, ticketing, and later features. The first-release decision was recorded in [ticket #3](https://github.com/fvckzest/HP-OS/issues/3#issuecomment-5848567711). Keeping it here avoids repeating the same ownership rules in every feature file.

## Settled rules

- A customer organization owns one or more Sites. Each Site belongs to exactly one organization. Moving a Site between organizations is outside the first release.
- Each Site owns its events, buyer records, orders, tickets, admission records, and sales totals. Buyer and order records are not shared across Sites. Combined organization reporting is deferred.
- Each Site backend has its own HP-OS API key. The Site's CRUD interface authenticates and authorizes staff. HP-OS authorizes the server-to-server call and enforces the key's Site boundary. HP-OS has no staff login or organization administrator role in the first release. A person overseeing multiple Sites uses the relevant Site interfaces.
- The organization owns payment connections. It may explicitly assign one connection to several Sites or use separate connections. Sharing a connection does not change which Site owns an order or ticket.
- The customer is the seller for ticket sales. HP-OS receives a platform fee through the payment provider. One fee agreement belongs to the organization and applies across its Sites.
- HP-OS operators manually set up organizations, Sites, connection assignments, API keys, and fee terms in the first release. Customers use Site CRUD interfaces for daily operations.

These boundaries keep operational records Site-specific while allowing an organization to share a payment connection and fee agreement across its Sites. See the [decision discussion](https://github.com/fvckzest/HP-OS/issues/3#issuecomment-5848567711) for context.

## Pending details

Provider fee mechanics, credential handling, and webhook routing belong to [provider research](https://github.com/fvckzest/HP-OS/issues/5) and [provider ownership](https://github.com/fvckzest/HP-OS/issues/9). Exact API-key behavior belongs in the [API contract](api.md) after [ticket #10](https://github.com/fvckzest/HP-OS/issues/10) is resolved.
