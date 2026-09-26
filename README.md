# HP-OS

HP-OS is a shared cultural operations engine for LMNL-built websites. Events and ticketing are the first planned capabilities. LMNL is the first Site. This repository currently contains planning documents and research, not an implemented HP-OS application. The [first-release Wayfinder issue](https://github.com/fvckzest/HP-OS/issues/1) indexes current planning work; [issue #6](https://github.com/fvckzest/HP-OS/issues/6) settles the first-release jobs, [issue #7](https://github.com/fvckzest/HP-OS/issues/7) names their domain concepts, and [issue #8](https://github.com/fvckzest/HP-OS/issues/8) will define their detailed journey.

## Find the current guidance

| Need | Source |
| --- | --- |
| Customer organization, Site, and payment-connection boundaries | [Ownership](docs/ownership.md) |
| Meanings and relationships of event and ticketing terms | [Domain language](CONTEXT.md) |
| Event rules | [Events](docs/features/events.md) |
| Ticketing rules | [Ticketing](docs/features/ticketing.md) |
| Exact Site-to-HP-OS request, response, permission, and error rules | [API contract](docs/api.md) |
| Current questions and work | [First-release Wayfinder issue](https://github.com/fvckzest/HP-OS/issues/1) and its linked tickets |
| Dated source evidence | [Research](docs/research/) |

Repository documents state settled guidance. GitHub issues hold open questions and current work; resolution comments preserve the full decision discussion. Research records evidence and does not establish HP-OS behavior by itself.

## Keep the guidance current

Update affected feature and API documents when a decision settles or behavior changes, in the same piece of work. Update this README when HP-OS gains a capability or documentation entry point. Internal changes that do not alter those entry points need only update the affected technical document. State rules briefly, explain why, and link to the deciding issue instead of duplicating its discussion. This documentation structure was agreed in [ticket #4](https://github.com/fvckzest/HP-OS/issues/4).
