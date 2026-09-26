# Site-to-HP-OS API contract

This is the single home for exact API operations, permissions, request and response fields, and error behavior. [Ticket #10](https://github.com/fvckzest/HP-OS/issues/10) will define the first contract. No endpoints or payloads have been settled yet.

The agreed boundary is that each Site backend uses its own HP-OS API key, and HP-OS enforces that key's Site scope. The Site authenticates and authorizes its staff. See [ownership](ownership.md) and the [decision in ticket #3](https://github.com/fvckzest/HP-OS/issues/3#issuecomment-5848567711).

The Site API must expose event gross paid sales, refunded amount, and net sales totals. The journey decision is in [ticket #8](https://github.com/fvckzest/HP-OS/issues/8); exact operations, fields, and permissions remain for [ticket #10](https://github.com/fvckzest/HP-OS/issues/10).

The Site API must also expose event counts for Tickets issued, Tickets currently valid for Admission, and Tickets admitted. These are distinct because a refunded Ticket remains in history but loses its admission right. See [ticket #8](https://github.com/fvckzest/HP-OS/issues/8); exact response fields remain for [ticket #10](https://github.com/fvckzest/HP-OS/issues/10).

Archived Event details must remain retrievable through the Site API so a Site can present past Events and keep direct Event pages available. See [ticket #8](https://github.com/fvckzest/HP-OS/issues/8); exact listing and retrieval operations remain for [ticket #10](https://github.com/fvckzest/HP-OS/issues/10).

When operations are decided, define them here once. Feature files should link to the relevant section rather than copy request and response rules.
