# Fake LMNL local workflow dashboard

This isolated local tool implements the local dashboard in [HP-OS issue #78](https://github.com/fvckzest/HP-OS/issues/78). It runs as its own Docker container. The browser talks to the Fake LMNL server, which holds the dedicated Site key and calls HP-OS over HTTP. It neither imports HP-OS domain functions nor connects to PostgreSQL. The existing HP-OS operator command is used only by a separate, explicit host setup command.

## Start the container

From the HP-OS checkout, start your existing local services with `pnpm local`. Then, in a second terminal:

```sh
cd test-site
npm run setup
node snapshot.mjs
docker compose up --build -d
```

If you already have local test Site credentials, copy `.env.example` to `.env`, fill in `HPOS_SITE_API_KEY`, `HPOS_SITE_ID`, `HPOS_CONNECTION_ID`, and optionally `HPOS_OTHER_SITE_API_KEY`, and skip `npm run setup`. `.env` is ignored by Git and excluded from the Docker image. The legacy `.env.local` file is loaded first for compatibility; values in `.env` take precedence. After editing credentials, run `docker compose up -d --force-recreate`.

Open **http://127.0.0.1:3100**. No package installation is needed for this tool; it uses Node.js built-in modules. The dashboard also starts without `.env`, showing workflows as blocked until configured.

`npm run setup` creates a separate local Organization, primary Site, secondary isolation Site, a test payment connection assigned to both Sites, and server-side keys using `scripts/operator.ts`. It writes `.env` with restrictive file permissions and does not print keys. It refuses to replace a configured Site key. An empty `.env` template is populated without replacing optional provider settings. It marks eligibility as **simulation-only**, with platform-fee eligibility ineligible to match the documented Sandbox limit. This is synthetic configuration, not actual provider eligibility. It creates no Events, Orders, payments or notifications and runs no workflow. Setup is executed on the host because the dashboard container has no database or repository access.

`node snapshot.mjs` checks that all 49 documented API method/path pairs have an explicit ticket mapping and captures the HP-OS revision, working-tree status, contract hash, and implementation hash. Run it again before rebuilding against changed HP-OS code. The dashboard identifies this as a **source snapshot**; it cannot independently establish the running HP-OS revision through an API that has no version endpoint.

The container connects to `http://host.docker.internal:3000`. Docker Desktop provides this address for host services: [Docker networking guidance](https://docs.docker.com/desktop/features/networking/networking-how-tos/). HP-OS remains a separate service. If its loopback listener cannot be reached in your Docker configuration, use the dedicated Compose host-network override described below, or run HP-OS in a Docker network under the `hpos` service name. Do not point this tool at a hosted or production service.

```sh
docker compose logs --tail 40
docker compose stop
docker compose start
docker compose down
```

`stop` and `down` preserve evidence in the named `test-site-evidence` volume. Do not use `down --volumes` unless you intentionally want to delete private request history and evidence. The dashboard's port is published only on `127.0.0.1`. The container runs as the non-root `node` user with a read-only application filesystem and a writable evidence volume. Provider configuration is injected at runtime; `.env`, provisioning records, and evidence are excluded from the build context.

## Run and interpret a workflow

1. Leave **Local simulation** selected unless you intend to call external test services.
2. Expand a workflow's buyer, staff and worker steps, then select **Run workflow**.
3. The current run and HTTP step appear above the checklist. While running, saved progress refreshes every two seconds; **Refresh saved status** and **Interrupt current run** remain available. Refresh reads saved records and does not run or poll HP-OS.
4. Open the saved Fake LMNL buyer pages or redacted HTTP evidence as needed. Buyer-page opening explicitly performs its current read through the server adapter.
5. Export redacted evidence for later review. Keep the original profile and limitations with every result.

Each runnable scenario has one explicit Run action. The complete checklist covers tickets #23–55 and keeps their acceptance criteria visible. Unimplemented capabilities are unavailable. Missing configuration and release prerequisites are blocked. A scenario can be not run, passed, failed, interrupted, or have an unknown outcome. Passing a subset does not pass its ticket, #33, #51, or any release gate. Hosted/cutover checks and sales approval have no local execution action. This tool supplies a prerequisite for collecting #51 evidence; it does not execute or complete #51.

The **Connected public single-ticket rehearsal** is the supported local workflow for Issue #33. It records the sequence in one saved run: accepted Order total and provider checkout registration, confirmation-pending access before payment, verified payment, one issued Ticket, initial email dispatch and separate delivery evidence, Order and individual Ticket reads, and one successful Admission followed by a rejected repeat. The simulation profile uses synthetic provider and email reports. The Sandbox profile uses Square Sandbox and sends only to the configured operator email through Resend. A passed run is implementation evidence for the dashboard workflow; it does not check off Issue #33 or claim the deferred LMNL cutover proof.

The **Discover an unresolved checkout frontier** workflow covers the locally runnable Issue #34 boundary. It records an unknown synthetic provider outcome, reads the Site-scoped verification list with the frozen connection and Order deadline, confirms that a replacement attempt remains blocked, and invokes the bounded HP-OS scheduler. It does not call a provider, close a real checkout, simulate a process restart, advance the database clock, or establish delayed confirmation or last-capacity restoration; those checks remain database and cutover evidence.

The **Investigate and resolve conflicting payment evidence** workflow covers the locally runnable Issue #35 boundary. It submits contradictory synthetic payment evidence before fulfillment, verifies that HP-OS retains the report and an open investigation issue without issuing a Ticket, checks the Site-scoped verification frontier and attempt detail, rejects stale and invalid guarded resolutions, and applies a valid new-source resolution before checking one Ticket, idempotent replay, and delayed evidence. It also checks that a valid paid resolution removes resolved conflict history from `requires_report_work=true`, while a later unapplied stale report is discoverable through that Site-scoped frontier without changing paid state. Provider verification, LMNL durable outbox interruption/restart, real staff views, and cutover proof remain deferred; this workflow uses the same Fake LMNL HTTP boundary and never contacts a payment provider.

The **Recover a paid Order awaiting Tickets** workflow covers the locally runnable Issue #36 boundary. It reads the operational Order with its Ticket and notification evidence, runs the bounded scheduler without visitor traffic, and verifies that a guarded retry of an already-issued Order returns `invalid_state` without duplicating a Ticket or initial email job. The Fake boundary does not inject failures; deliberate automatic and guarded interruption/recovery paths are exercised by `pnpm verify:events` against local PostgreSQL. Provider, hosted worker, email, and LMNL cutover testing remain deferred.

The **Recover failed Ticket email and correct delivery address** workflow covers the locally runnable Issue #37 boundary. It records a confirmed delivery failure, requests a guarded resend of the existing Ticket, verifies the original failed job and Ticket identity remain visible, performs a verified delivery-email correction, checks that checkout identity, Ticket identity, QR and Admission history remain unchanged, and leaves an unknown replacement dispatch fenced against blind resend. The local HP-OS verifier separately proves explicit transient and permanent dispatch classification. Provider delivery, hosted workers, actual email, and LMNL cutover testing remain deferred.

The **Correct delivery email without changing entry rights** workflow covers the local Issue #39 correction race. It claims an Order recovery email before staff correction, then checks that the old normal and temporary Order links no longer open, staff lookup follows the corrected address, and the claimed stale recovery job is recorded as permanently skipped without sending. It also checks that the replacement Ticket keeps its ID, QR payload, and Admission history. The HP-OS PostgreSQL verifier additionally checks an existing corrected Site Buyer profile and a synthetic approved-attendee field. Wallet-device/private-approval integration, hosted workers, real email, and cutover evidence remain deferred.

The isolation scenario requires both Sites to share the configured test connection. It checks cross-Site Events, related records, Order and Ticket tokens, and checkout-reference reuse. If you supply existing credentials, assign the same test connection to both Sites with the operator CLI before running this scenario. It creates synthetic paid records and a secondary unpaid Order; it does not send email.

Checkout-reference isolation is enforced by HP-OS through its normal HTTP API: reusing a reference owned by another Site on a shared connection returns `404 not_found` without foreign attempt details, while same-Site reuse returns `409 provider_reference_conflict`. The [API contract](../docs/api/api.md#payment-metadata-and-attempts) records this rule from [issue #80](https://github.com/fvckzest/HP-OS/issues/80). `pnpm verify:events` checks sequential and concurrent cross-Site reuse, same-Site conflicts, and the single-owner database constraint. A passing dashboard scenario remains scenario evidence; it does not establish release readiness.

Runs save request identities and the pending HTTP step **before** sending requests. A failed connection on a read is blocked with its connection error; uncertainty about a sent mutation remains an unknown outcome. Container restart leaves unfinished runs interrupted or unknown; it never starts or resumes work automatically. Resume the saved run to reuse its original keys. A failed deterministic check stays failed. Changes to configuration, dashboard code or source snapshot prevent resuming old requests without review. External uncertain sends older than 24 hours are blocked because provider idempotency may have expired; provider/durable-log verification is required before resend.

The simulated Site worker may complete up to 100 preceding known Ticket-email jobs on the same dedicated Site during an explicitly started delivery workflow. All requests appear in that run's evidence. Unknown or expired-claim jobs require verification and block dispatch. Sandbox refuses unrelated email backlog. Unknown-dispatch rehearsal intentionally leaves unresolved work and does not resend it. Fixture Events, Orders and Tickets remain in local HP-OS for inspection; no automatic cleanup or database reset occurs.

## Optional Square Sandbox and Resend

Only the connected #33 rehearsal supports the external profile. Add the server-side values from `.env.example` to `.env`: `SQUARE_SANDBOX_ACCESS_TOKEN`, `SQUARE_SANDBOX_LOCATION_ID`, `SQUARE_ACCOUNT_ALIAS`, `SQUARE_LOCATION_ALIAS`, `RESEND_API_KEY`, `RESEND_FROM`, and an `OPERATOR_EMAIL` address you own. Use the existing operator command to record **independently verified** Sandbox account eligibility and a non-secret evidence reference; the simulation-only evidence marker blocks external runs. Recreate the container after configuration changes with `docker compose up -d --force-recreate`.

Selecting **Square Sandbox + actual Resend email** enables a configured #33 run. The adapter creates a Sandbox Quick Pay checkout for the frozen total, verifies its Square Order, and registers its reference in HP-OS before presenting it. Complete checkout in Square Sandbox, obtain its payment ID, and **Resume** the saved run. The server retrieves the payment and verifies completed status, exact checkout Order/location/amount/currency and no extra tip before reporting paid. It sends one email only to `OPERATOR_EMAIL`, then pauses until an explicit Resume verifies Resend delivery. Resume accepts the same saved payment ID while delivery is pending; changing that identity after a payment report starts is rejected. A send response alone never counts as delivered. No real account credentials or buyer access tokens enter exported evidence.

Provider references: [Square CreatePaymentLink](https://developer.squareup.com/reference/square/checkout/create-payment-link), [Square GetPayment](https://developer.squareup.com/reference/square/payments/get-payment), [Resend send](https://resend.com/docs/api-reference/emails/send-email), [Resend retrieve](https://resend.com/docs/api-reference/emails/retrieve-email), and [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys). This implementation has not established real provider behavior. Sandbox platform-fee collection is unavailable under the current HP-OS integration rules; no settlement, supported-device, hosted, or production proof follows from this profile.

## Separate local-server networking

For another local Docker server, put the HP-OS service and this container on the same network with service name `hpos`, and use `FAKE_LMNL_HPOS_ORIGIN=http://hpos:3000`. The upstream allowlist accepts only that service name or `host.docker.internal`, using HTTP ports 3000–3999. The dashboard's host-execution option accepts only `127.0.0.1`; arbitrary remote hosts and URL credentials are rejected.

If Docker Desktop cannot reach your host's loopback-only HP-OS listener, enable its **host networking** setting and use:

```sh
docker compose -f compose.yaml -f compose.host.yaml up --build -d
```

This override keeps the dashboard bound to `127.0.0.1` and uses host loopback for HP-OS. Host networking requires Docker Desktop's opt-in support: [Docker host-network guidance](https://docs.docker.com/engine/network/drivers/host/). No HP-OS bind-address change is necessary.

## Verify the dashboard implementation

```sh
npm test
docker compose config --quiet
```

These focused tests verify route coverage, local-target restrictions, redaction, unknown-mutation replay, preserved failures, external email restrictions, passive startup/refresh, browser action authorization, and restart behavior. Their synthetic HTTP responses are implementation checks only, not HP-OS/PostgreSQL/provider or release proof. No visual review is performed. The tool source and this guidance are version-controlled. `.env`, legacy `.env.local`, provisioning records, generated source snapshots, and saved evidence remain ignored.
