# First-release technology

This document records the technology and implementation-order decisions agreed during [issue #11](https://github.com/fvckzest/HP-OS/issues/11). [Issue #23](https://github.com/fvckzest/HP-OS/issues/23) provides a local Next.js application, direct PostgreSQL access, and version-controlled migrations. [Issue #24](https://github.com/fvckzest/HP-OS/issues/24) adds the first `/v1` slice for Site-key authentication and payment-configuration reads. Events, ticketing, and hosted readiness remain unimplemented or unverified.

## Language and deployment

- Use TypeScript for version 1. Defer Rust until after moving to self-hosting, keeping the initial implementation and deployment simple.
- Use one Next.js application for the small public website at `hp-os.dev` and the TypeScript API. Preserve the agreed `/v1` API paths. Keep business rules in ordinary TypeScript modules called by route handlers, so they can be tested separately from HTTP and scheduling.
- Use Vercel for initial hosting. The repository declares the Next.js framework in `vercel.json`; actual deployment and hosted database connectivity remain unverified. Future hosting is intended to use Coolify and Docker on local hardware; that migration is separate from the later language change.
- Use Supabase PostgreSQL as the database.

These choices prioritize a manageable first release while preserving the user's intended path to self-hosting and Rust. They do not change the [API contract](api/api.md) or the [Site ownership and credential boundaries](ownership.md).

## Database access and changes

- Execute SQL directly from the backend rather than adding an ORM, so database transactions and queries remain explicit.
- Keep database schema changes in version-controlled SQL migration files, so environments can apply the same reviewed changes reproducibly.

Implementation must preserve Site ownership in both queries and related-record constraints. Use database transactions and uniqueness constraints for concurrent capacity allocation, issuance, idempotency records, and Admission; an application-level check followed by a separate write is insufficient. Save pending work with its triggering change in the same transaction. Supabase's generated Data API must not provide an alternate public path to operational records. These are consequences of the existing contract, not new public API behavior.

The database implementation must satisfy the contract's concurrency, retry, and isolation requirements, including atomic capacity allocation, duplicate-safe Ticket issuance, and one successful Admission per Ticket. Choosing a language or database service does not establish that those requirements have been verified.

## Background processing

- Store pending HP-OS work durably in PostgreSQL and use Vercel Cron to trigger processing in small, bounded batches. A scheduled invocation starts processing; it does not replace the stored work record.
- Processing must tolerate overlapping invocations, interrupted batches, and repeated attempts without duplicating business effects. Use database-backed claims and retry state consistent with the [API contract](api/api.md).
- Site backends continue to verify provider payments, send email, and sign or update Wallet passes using their own credentials. HP-OS queues notification work and exposes the agreed claim and reporting operations; an HP-OS cron invocation does not execute those Site-owned integrations.

This approach keeps first-release scheduling on Vercel and durable recovery state in the existing database, without adding a separate queue service. Scheduler and worker behavior still require implementation evidence, including recovery when no visitor requests arrive. Site-owned workers need their own scheduled execution; scheduling HP-OS alone cannot complete the end-to-end recovery path. These responsibilities were agreed during [issue #11](https://github.com/fvckzest/HP-OS/issues/11) and preserve the credential boundary from [issue #10](https://github.com/fvckzest/HP-OS/issues/10).

## Local development and hosted cutover

Issue #23 implements the local foundation with Supabase CLI-managed PostgreSQL and SQL migrations. `pnpm local` starts the local database and Next.js development server, applies pending migrations, verifies the HP-OS operational schema, and binds the app to `127.0.0.1`. The generated Supabase Data API is disabled. These controls prepare local development only; they do not prove hosted database connectivity or authorize a production cutover.

- Use the Supabase CLI with Docker to run the local Supabase environment during development and testing. A hosted HP-OS Supabase project is deferred until readiness for LMNL cutover because the current plan has no available project capacity.
- Run the database-dependent Next.js application and HP-OS and Site processing locally against test data. Exercise scheduled processing through a local scheduler or test runner using the same processing code; Vercel Cron is the hosted scheduling target, not evidence of local execution.
- Keep local database services private. A Vercel Preview deployment does not automatically have access to the local Docker database. Do not expose that database publicly to enable Preview testing.
- Apply the reviewed migrations to hosted Supabase when capacity is available for cutover preparation. Verify hosted database connectivity, scheduler behavior, provider callbacks, and the complete LMNL integration before switching production traffic. Local proof does not establish hosted readiness.

This keeps development independent of hosted project capacity. Local setup follows the [Supabase local development guidance](https://supabase.com/docs/guides/local-development); the timing was agreed during [issue #11](https://github.com/fvckzest/HP-OS/issues/11).

## Implementation order

The following order was agreed during [issue #11](https://github.com/fvckzest/HP-OS/issues/11). Each stage includes verification of its own behavior.

1. **Foundation:** establish the Next.js application and deployment configuration, local Supabase, migrations, Site API keys, Site isolation, and durable background processing. Prepare hosting configuration locally; database-dependent hosted verification waits for cutover preparation.
2. **Public single-ticket journey:** implement Event setup, checkout, Site-verified payment reporting, Ticket issuance, email, Order access, individual QR access, and Admission as one connected flow.
3. **Recovery:** verify interrupted checkout, duplicate or conflicting reports, failed issuance, email retry, buyer recovery, refunds, and totals. Essential retry and transaction safeguards belong in their triggering operations from the outset, rather than being postponed to this stage.
4. **Private Events and Wallet:** implement Access Request approval and protected single-ticket checkout, plus Site-owned Wallet generation and updates.
5. **Public multi-ticket purchase:** extend the verified single-ticket flow to independently presentable Tickets without duplicate issuance or Admission.
6. **Release verification:** prove the complete journeys and failure handling with actual integrations, then verify the hosted environment before LMNL cutover. Follow the [ticketing release proof](features/ticketing.md#release-proof) and [LMNL release checklist and cutover procedure](release-and-cutover.md). All required local and hosted checks precede a controlled real purchase and refund; explicit user approval is required before opening public sales.

The full single-ticket flow must be proven before public multi-ticket purchasing. Completing these stages locally does not authorize production cutover or prove provider fee settlement.
