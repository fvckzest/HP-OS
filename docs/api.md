# Site-to-HP-OS API contract

This is the single home for exact API operations, permissions, request and response fields, and error behavior. [Ticket #10](https://github.com/fvckzest/HP-OS/issues/10) will define the first contract. No endpoints or payloads have been settled yet.

The agreed boundary is that each Site backend uses its own HP-OS API key, and HP-OS enforces that key's Site scope. The Site authenticates and authorizes its staff. See [ownership](ownership.md) and the [decision in ticket #3](https://github.com/fvckzest/HP-OS/issues/3#issuecomment-5848567711).

When operations are decided, define them here once. Feature files should link to the relevant section rather than copy request and response rules.
