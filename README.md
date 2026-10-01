# HP-OS

HP-OS is a shared cultural operations engine for LMNL-built websites. LMNL is the first Site. [Issue #23](https://github.com/fvckzest/HP-OS/issues/23) provides the TypeScript/Next.js application and persistent local PostgreSQL. [Issue #24](https://github.com/fvckzest/HP-OS/issues/24) adds operator-managed Organizations, Sites, Site API keys, payment-connection assignments, Site authentication, and Site-scoped payment-configuration reads. [Issue #25](https://github.com/fvckzest/HP-OS/issues/25) adds durable Site-scoped notification jobs, lease-fenced claims, dispatch and delivery reports, and bounded PostgreSQL recovery shared by local scheduling and Vercel Cron. [Issue #26](https://github.com/fvckzest/HP-OS/issues/26) adds Site-scoped Event drafts, guarded edits, publication, eligible Event archiving, and current/past public discovery. [Issue #27](https://github.com/fvckzest/HP-OS/issues/27) adds authoritative sales status, guarded stop/resume actions, and capacity edits that preserve held Reservations; its LMNL staff controls remain in unmerged draft [PR #83](https://github.com/fvckzest/LMNL/pull/83) until the cutover window. [Issue #28](https://github.com/fvckzest/HP-OS/issues/28) adds explicit Organization-level 10% pilot-fee setup, complete single-Ticket quotes, unpaid Orders, capacity Reservations, and LMNL's prepayment Order view. [Issue #29](https://github.com/fvckzest/HP-OS/issues/29) adds frozen payment connections, operator-recorded provider eligibility, one unresolved payment attempt per Order, and provider checkout-reference registration in HP-OS. Its Square-hosted single-Ticket checkout is implemented in Draft [LMNL PR #85](https://github.com/fvckzest/LMNL/pull/85), which remains Draft until cutover. [Issue #30](https://github.com/fvckzest/HP-OS/issues/30) adds Site-verified payment reports, durable Ticket issuance recovery, and buyer access to the current Order and Ticket state. Its LMNL webhook and Square-return integration stays Draft until cutover. [Issue #32](https://github.com/fvckzest/HP-OS/issues/32) adds an atomic Site/Event-scoped Admission API and manual Ticket lookup; LMNL's limited door interface remains Draft until cutover. [Issue #34](https://github.com/fvckzest/HP-OS/issues/34) adds bounded promotion of overdue unresolved payment attempts and a Site-scoped verification frontier so scheduled Site workers can recover interrupted checkout safely after restart. [Issue #35](https://github.com/fvckzest/HP-OS/issues/35) adds retained payment-conflict history, Site-scoped investigation data, guarded verified resolution with idempotent replay and stale-observation protection, and the `requires_report_work=true` frontier for unapplied delayed reports. Its LMNL worker and staff integration remain Draft until cutover. The local checks use synthetic provider evidence; they do not establish real Square, hosted, live fee-settlement, physical-device, or production behavior. The [first-release Wayfinder issue](https://github.com/fvckzest/HP-OS/issues/1) indexes current planning work; [issues #6](https://github.com/fvckzest/HP-OS/issues/6), [#7](https://github.com/fvckzest/HP-OS/issues/7), and [#8](https://github.com/fvckzest/HP-OS/issues/8) settle first-release jobs, domain concepts, and the detailed ticketing journey.

## Run locally

First install Node.js 22.6 or later, pnpm 11, and a running Docker-compatible container service. The Supabase local stack uses Docker and must stay on the local machine.

```sh
pnpm install
pnpm local
```

The `pnpm local` command starts local PostgreSQL and Supabase Studio for database browsing, applies pending version-controlled migrations, verifies the HP-OS operational schema, binds the Next.js app to `127.0.0.1`, and prints `http://127.0.0.1:3000`. The Supabase CLI prints Studio's local URL during startup. For persistent operator setup, run `pnpm operator help`; the operator command defaults to the local database. Payment account and location references use operator-defined `ref:` aliases that map to configuration held by the Site backend; HP-OS rejects other values so provider credentials cannot be stored in these fields. Site API keys are shown once by the key command and must be stored in the Site backend environment, such as `HPOS_SITE_API_KEY` in a local `.env.local`. Never put them in browser code. Stop the app with Ctrl-C. The local database volume persists; `pnpm local:stop` stops its services without resetting data. Supabase runtime files stay in the ignored `.local-supabase-home/` directory, and CLI telemetry is disabled for these local commands.

In a second terminal, `pnpm test` verifies the local PostgreSQL schema, confirms the generated Supabase Data API is disabled, and checks operator provisioning, connection eligibility evidence, Organization pilot-fee setup, Site isolation, shared connections, Site-wide request limits, key authentication, rotation, and revocation through HTTP. It removes the synthetic Organization records it creates. `pnpm verify:events` checks Event drafts, sales controls against actual Reservations, preserved purchase terms after Event edits, restored availability after Reservation release, public discovery, explicit checkout pricing, quote and Order retries, payment-attempt idempotency, safe provider closure and replacement rules, verified payment reports, interrupted and retried Ticket issuance, buyer Order/Ticket access, manual Ticket lookup, Admission eligibility and rejection precedence, same-key replay, concurrent scans, and last-capacity protection against synthetic local data. `pnpm typecheck` checks TypeScript; `pnpm build` creates the production build.

Event, quote, unpaid Order, payment-attempt state transitions, verified payment reports, Ticket issuance recovery, Reservation-backed sales controls, and Admissions have local PostgreSQL API coverage. LMNL's Draft checkout integration verifies Square through the Site backend, but local checks do not call Square. Physical-device scan behavior, hosted LMNL behavior, live checkout, and actual fee settlement remain unverified. Local PostgreSQL checks do not establish hosted database, provider, device, or production readiness. The 10% Organization pilot-fee value must be configured explicitly; tax and buyer-fee inputs must also be explicit before a quote is available.

Next.js manages `next-env.d.ts` and the `.next/` directory locally; both are excluded from Git so generated development and build changes do not block pulls. `pnpm typecheck` runs `next typegen` before TypeScript checking, which regenerates the required definitions even in a fresh checkout. Keep `next-env.d.ts` in `tsconfig.json` so TypeScript can load those definitions.

## Repository layout

The [Fake LMNL workflow dashboard](test-site/README.md), built for [issue #78](https://github.com/fvckzest/HP-OS/issues/78), runs in a separate local Docker container on port 3100. It maps the documented API routes and tickets #23–55, sends explicitly started workflows through a server-side Site adapter, and saves redacted scenario evidence. Its local `.env`, provisioning records, generated source snapshot, and evidence remain excluded from Git. Creating or opening the dashboard does not execute workflows, and scenario results do not establish provider, hosted, device, cutover, or release proof.

Application code lives in `src/`: `src/app/` contains Next.js pages and routes, and `src/server/` contains HP-OS server logic. The `@/` import alias points to `src/`. Operational commands and verification scripts live in `scripts/`; database configuration and migrations live in `supabase/`; settled guidance lives in `docs/`. `CONTEXT.md` remains at the root as the domain glossary.

Tool configuration, dependency files, `README.md`, and `AGENTS.md` remain at the root. Generated TypeScript cache data lives in `.next/cache/`. macOS `.DS_Store` metadata is excluded from Git.

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
| Local Docker Site workflow tool, configuration, and evidence | [Fake LMNL dashboard](test-site/README.md) |

Repository documents state settled guidance. GitHub issues hold open questions and current work; resolution comments preserve the full decision discussion. Research records evidence and does not establish HP-OS behavior by itself.

[Issue #9](https://github.com/fvckzest/HP-OS/issues/9) settles data separation and payment execution: provider credentials and calls remain on Site backends; HP-OS owns operational records, authoritative amounts, connection assignments, and fee terms. The detailed rules are in [Ownership](docs/ownership.md#data-separation-and-payment-execution). Provider integration and fee settlement remain unverified.

[Issue #10](https://github.com/fvckzest/HP-OS/issues/10) defines the first API contract. Its settled credential boundary is that HP-OS retains no Site or organization external service credentials; Site backends execute credential-dependent integrations, including Apple Wallet signing. See [external service credentials](docs/ownership.md#external-service-credentials) and the [API contract](docs/api/api.md).

## Keep the guidance current

Update affected feature and API documents when a decision settles or behavior changes, in the same piece of work. Update this README when HP-OS gains a capability or documentation entry point. Internal changes that do not alter those entry points need only update the affected technical document. State rules briefly, explain why, and link to the deciding issue instead of duplicating its discussion. This documentation structure was agreed in [ticket #4](https://github.com/fvckzest/HP-OS/issues/4).
