# HP-OS

HP-OS is a shared cultural operations engine for LMNL-built websites. Events and ticketing are the first planned business capabilities. LMNL is the first Site. The initial implementation in [issue #23](https://github.com/fvckzest/HP-OS/issues/23) adds the TypeScript/Next.js application, a persistent local PostgreSQL foundation, and a loopback-only testing workbench. Event, ticketing, Site authentication, and LMNL business operations remain unavailable. The [first-release Wayfinder issue](https://github.com/fvckzest/HP-OS/issues/1) indexes current planning work; [issue #6](https://github.com/fvckzest/HP-OS/issues/6) settles the first-release jobs, [issue #7](https://github.com/fvckzest/HP-OS/issues/7) names their domain concepts, and [issue #8](https://github.com/fvckzest/HP-OS/issues/8) defines their detailed journey in the Events and Ticketing guidance below.

## Run locally

First install Node.js 22 or later, pnpm 11, and a running Docker-compatible container service. The Supabase local stack uses Docker and must stay on the local machine.

```sh
pnpm install
pnpm local
```

The `pnpm local` command starts local PostgreSQL, applies pending version-controlled migrations, verifies the dedicated local test database, binds the Next.js app to `127.0.0.1`, and prints the workbench URL. Open `http://127.0.0.1:3000/workbench`. Stop the app with Ctrl-C. The local database volume persists; `pnpm local:stop` stops its services without resetting data. Supabase runtime files stay in the ignored `.local-supabase-home/` directory, and CLI telemetry is disabled for these local commands.

In a second terminal, `pnpm test` starts temporary app processes and verifies the real local PostgreSQL boundary, confirms the generated Supabase Data API is disabled, checks request redaction and local access guards, forces a diagnostic-history write failure, and verifies history across an app restart. It leaves one sanitized expected-404 probe in workbench history; its omitted HTML response body is marked incomplete. `pnpm typecheck` checks TypeScript; `pnpm build` creates the production build, where local workbench routes remain disabled.

This local foundation does not implement `/v1` business operations or a local LMNL integration. It does not establish hosted database, provider, device, or production readiness.

The browser workbench opens the API Explorer by default. Browse documented endpoints by HP-OS domain in the left column, prepare requests in the center console, and read field definitions and current-session values in the right glossary panel. Documented business endpoints are marked unavailable until implemented; the Custom `/v1` request entry remains available for local routes that do exist. Guided Workflows sit below the Explorer, and shared sanitized History stays at the bottom of the page.

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
| Settled local API Explorer form factor, workbench workflow, test controls, delivery plan, and functional verification | [Local testing workbench](docs/local-workbench.md) |
| Consolidated local workbench specification and implementation handoff | [HP-OS local API workbench implementation specification](https://github.com/fvckzest/HP-OS/issues/66) |
| Current questions and work | [First-release Wayfinder issue](https://github.com/fvckzest/HP-OS/issues/1) and its linked tickets |
| Dated source evidence | [Research](docs/research/) |
| Local workbench tracing feasibility and integration boundaries (research; settled plan takes precedence) | [Local call tracing](docs/research/local-call-tracing.md) |
| Planned local workbench API and workflow coverage | [Local testing coverage research](docs/research/local-api-workflow-testing-coverage.md) |

Repository documents state settled guidance. GitHub issues hold open questions and current work; resolution comments preserve the full decision discussion. Research records evidence and does not establish HP-OS behavior by itself.

[Issue #9](https://github.com/fvckzest/HP-OS/issues/9) settles data separation and payment execution: provider credentials and calls remain on Site backends; HP-OS owns operational records, authoritative amounts, connection assignments, and fee terms. The detailed rules are in [Ownership](docs/ownership.md#data-separation-and-payment-execution). Provider integration and fee settlement remain unverified.

[Issue #10](https://github.com/fvckzest/HP-OS/issues/10) defines the first API contract. Its settled credential boundary is that HP-OS retains no Site or organization external service credentials; Site backends execute credential-dependent integrations, including Apple Wallet signing. See [external service credentials](docs/ownership.md#external-service-credentials) and the [API contract](docs/api/api.md).

## Keep the guidance current

Update affected feature and API documents when a decision settles or behavior changes, in the same piece of work. Update this README when HP-OS gains a capability or documentation entry point. Internal changes that do not alter those entry points need only update the affected technical document. State rules briefly, explain why, and link to the deciding issue instead of duplicating its discussion. This documentation structure was agreed in [ticket #4](https://github.com/fvckzest/HP-OS/issues/4).
