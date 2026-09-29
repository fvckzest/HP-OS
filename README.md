# HP-OS

HP-OS is a shared cultural operations engine for LMNL-built websites. Events and ticketing are the first planned business capabilities. LMNL is the first Site. [Issue #23](https://github.com/fvckzest/HP-OS/issues/23) provides the TypeScript/Next.js application and persistent local PostgreSQL. [Issue #24](https://github.com/fvckzest/HP-OS/issues/24) adds operator-managed Organizations, Sites, Site API keys, payment-connection assignments, Site authentication, and Site-scoped payment-configuration reads. [Issue #25](https://github.com/fvckzest/HP-OS/issues/25) adds durable Site-scoped notification jobs, lease-fenced claims, dispatch and delivery reports, and bounded PostgreSQL recovery shared by local scheduling and Vercel Cron. Provider and email calls remain on the Site backend. Event and ticketing business operations remain unavailable. The [first-release Wayfinder issue](https://github.com/fvckzest/HP-OS/issues/1) indexes current planning work; [issue #6](https://github.com/fvckzest/HP-OS/issues/6) settles the first-release jobs, [issue #7](https://github.com/fvckzest/HP-OS/issues/7) names their domain concepts, and [issue #8](https://github.com/fvckzest/HP-OS/issues/8) defines their detailed journey in the Events and Ticketing guidance below.

## Run locally

First install Node.js 22.6 or later, pnpm 11, and a running Docker-compatible container service. The Supabase local stack uses Docker and must stay on the local machine.

```sh
pnpm install
pnpm local
```

The `pnpm local` command starts local PostgreSQL, applies pending version-controlled migrations, verifies the HP-OS operational schema, binds the Next.js app to `127.0.0.1`, and prints `http://127.0.0.1:3000`. For persistent operator setup, run `pnpm operator help`; the operator command defaults to the local database. Payment account and location references use operator-defined `ref:` aliases that map to configuration held by the Site backend; HP-OS rejects other values so provider credentials cannot be stored in these fields. Site API keys are shown once by the key command and must be stored in the Site backend environment, such as `HPOS_SITE_API_KEY` in a local `.env.local`. Never put them in browser code. Stop the app with Ctrl-C. The local database volume persists; `pnpm local:stop` stops its services without resetting data. Supabase runtime files stay in the ignored `.local-supabase-home/` directory, and CLI telemetry is disabled for these local commands.

In a second terminal, `pnpm test` verifies the local PostgreSQL schema, confirms the generated Supabase Data API is disabled, and checks operator provisioning, Site isolation, shared connections, Site-wide request limits, key authentication, rotation, and revocation through HTTP. It removes the synthetic Organization records it creates. `pnpm typecheck` checks TypeScript; `pnpm build` creates the production build.

Events, Orders, Tickets, Admissions, payment reports, and local LMNL integration are not implemented. Local PostgreSQL checks do not establish hosted database, provider, device, or production readiness. Concrete organization fee terms and payment-account eligibility remain pending validation; no fees are calculated by the current configuration API.

## Find the current guidance

| Need | Source |
| --- | --- |
| Customer organization, Site data separation, payment connections, and Site payment execution | [Ownership](docs/ownership.md) |
| Meanings and relationships of event and ticketing terms | [Domain language](CONTEXT.md) |
| Event rules | [Events](docs/features/events.md) |
| Ticketing rules | [Ticketing](docs/features/ticketing.md) |
| API components, endpoints, fields, and data formats at a glance | [API reference](docs/api/api-ref.md) |
| Exact Site-to-HP-OS request, response, permission, and error rules | [API contract](docs/api/api.md) |
| Agreed first-release language, hosting, and database approach | [Technology](docs/technology.md) |
| Required LMNL release evidence and cutover procedure | [Release and cutover](docs/release-and-cutover.md) |
| Current questions and work | [First-release Wayfinder issue](https://github.com/fvckzest/HP-OS/issues/1) and its linked tickets |
| Dated source evidence | [Research](docs/research/) |
| Planned API and workflow test coverage | [API workflow testing coverage research](docs/research/local-api-workflow-testing-coverage.md) |

Repository documents state settled guidance. GitHub issues hold open questions and current work; resolution comments preserve the full decision discussion. Research records evidence and does not establish HP-OS behavior by itself.

[Issue #9](https://github.com/fvckzest/HP-OS/issues/9) settles data separation and payment execution: provider credentials and calls remain on Site backends; HP-OS owns operational records, authoritative amounts, connection assignments, and fee terms. The detailed rules are in [Ownership](docs/ownership.md#data-separation-and-payment-execution). Provider integration and fee settlement remain unverified.

[Issue #10](https://github.com/fvckzest/HP-OS/issues/10) defines the first API contract. Its settled credential boundary is that HP-OS retains no Site or organization external service credentials; Site backends execute credential-dependent integrations, including Apple Wallet signing. See [external service credentials](docs/ownership.md#external-service-credentials) and the [API contract](docs/api/api.md).

## Keep the guidance current

Update affected feature and API documents when a decision settles or behavior changes, in the same piece of work. Update this README when HP-OS gains a capability or documentation entry point. Internal changes that do not alter those entry points need only update the affected technical document. State rules briefly, explain why, and link to the deciding issue instead of duplicating its discussion. This documentation structure was agreed in [ticket #4](https://github.com/fvckzest/HP-OS/issues/4).
