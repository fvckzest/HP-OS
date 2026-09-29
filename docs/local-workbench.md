# Local testing workbench

This document records local workbench decisions agreed with the product owner in [Choose the simplest beginner-friendly testing workflow](https://github.com/fvckzest/HP-OS/issues/58), [Decide repeatable test data and failure controls](https://github.com/fvckzest/HP-OS/issues/60), and [Settle incremental workbench delivery and verification](https://github.com/fvckzest/HP-OS/issues/61), under [Plan the HP-OS local API workbench](https://github.com/fvckzest/HP-OS/issues/56). The initial local foundation slice is implemented by [issue #23](https://github.com/fvckzest/HP-OS/issues/23); capability-specific workflows and controls remain for their existing implementation tickets.

## Implemented local foundation

Run `pnpm install` once, then `pnpm local` to start the loopback-only app and Supabase PostgreSQL stack. The command applies pending SQL migrations, checks the dedicated `local-test` marker by direct SQL, and prints `http://127.0.0.1:3000/workbench`. Docker and a Node.js 22+ runtime must already be installed and running. Stopping the app does not reset the PostgreSQL volume; `pnpm local:stop` stops the stack without resetting it. Supabase CLI runtime files stay in ignored `.local-supabase-home/`, and telemetry is disabled for these local commands.

The workbench shows app/database status, a one-step readiness workflow, and a version-controlled catalogue. Site-key authentication and the payment-configuration reads are available. Event, ticketing, and local LMNL operations remain unavailable. The manual request editor can prepare one request to a local `/v1/` route; it does not add a business API endpoint. Local workbench HTTP handlers are disabled in production, check the loopback Host, require a same-origin request for mutations, and reject non-local database and API targets. Redirects are not followed.

The Site access workflow creates temporary synthetic Organizations, Sites, non-secret payment connections, assignments, and Site keys, then checks the normal `/v1/` HTTP boundary for missing, rotated, and revoked keys; same-organization and cross-organization isolation; shared connections; a Site with no active connection; and a shared request budget across two active keys. Keys stay in server memory during the workflow, and call history redacts the Authorization header. The fixtures are removed at completion. These checks use local PostgreSQL and do not establish hosted provider-account eligibility or fee settlement.

Diagnostic requests are stored in the private `workbench` PostgreSQL schema using direct SQL. The Supabase generated Data API is disabled. Request and response snapshots are sanitized before storage; usable credentials, buyer details, path tokens, query strings, arbitrary free text, and malformed bodies are excluded or redacted. History clearing deletes only diagnostic history. JSON export includes all saved, already-sanitized records. The viewer shows the latest 100 records.

Run `pnpm test` while the local Supabase database is running. It exercises the workbench HTTP boundary against real PostgreSQL, verifies remote targets and cross-origin mutations are refused, checks redaction, forces one narrowly scoped diagnostic-history write failure, and restarts the app to confirm history persists. The check uses absent `/v1/` paths and creates no business record. It leaves one sanitized expected-404 probe in history; its omitted HTML response body is marked incomplete. This verifies local foundation behavior only.

No business API operation or local LMNL integration is implemented or simulated by this slice. Business success, expected-rejection, retry, concurrency, interruption, and recovery checks remain unavailable until the corresponding operations exist. The local verification command confirms that a diagnostic-history write failure leaves the HTTP result unchanged and marks capture incomplete. Run-time PostgreSQL boundary and restart evidence also remains unverified until the local container runtime is available.

## Starting point

Guided workflows are the default starting point. Each workflow explains its steps in plain technical English and provides access to inspect and edit the API requests. Manual requests are also available for testing an individual API call.

This gives a beginner a meaningful task to follow while retaining access to the underlying API. For example, a one-Ticket purchase workflow can guide the user through requesting a quote, creating an Order, simulating a payment report, and checking the issued Ticket. Simulated payment results establish local HP-OS behavior only; they do not prove a real payment integration.

## Execution

Workflows run one step at a time by default. Each step explains what it will do before sending its request, and the user can inspect its result before continuing. A “Run remaining steps” option also allows the user to execute the rest of the workflow without manually starting each step.

The default lets a beginner understand each operation and its result. The optional continuous execution supports repeat testing once the user understands the workflow.

## Request editing

Guided steps present plain labeled fields first. An expandable “Request details” section exposes the HTTP method, path, headers, and JSON body. The fields and request details are editable and stay synchronized, so either view represents the same request.

For example, changing “Ticket quantity” from `1` to `2` changes `quantity` in the JSON body. This lets a beginner use understandable inputs while learning how they map to the API request.

## Step results

Every guided step shows its expected result, actual result, and relevant operational records before and after execution. The actual result includes access to the response status, headers, and body. This lets the user compare the intended outcome with both the response and the observed record state.

A check passes when the actual result matches the expectation. An expected rejection is a passing check when the API rejects the request correctly; for example, rejecting a second Admission for an already admitted Ticket.

Before/after observations must state their evidence source. State fetched after a request is an observation, not by itself proof that the request caused that change. Missing observations must remain visible rather than being presented as unchanged state.

## Values shared between steps

The workbench automatically fills later requests with values returned by earlier steps, including record identifiers and the versions required by guarded operations. It shows each value's source and allows the user to inspect or override it before execution. For example, an Order ID is labeled as coming from the Create Order step.

The workbench also manages idempotency keys: a retry of the same request reuses its key, while a new operation receives a new key. A record version protects an edit against overwriting a newer change; an idempotency key prevents a repeated request from creating a duplicate write. Both remain visible and overridable in request details. These controls reduce copying errors without hiding what is sent or replacing the API's concurrency and retry rules.

## Unexpected results

An unexpected step result pauses the workflow, including during “Run remaining steps.” The workbench shows what differed from the expectation and leaves later steps unrun so the user can inspect the problem. An expected rejection that matches the check allows execution to continue.

If no response arrives, the workbench shows “Outcome unknown” and does not automatically repeat the request. The operation might already have succeeded; lack of a response is not evidence of failure. Recovery must respect the API's read, verification, and same-request idempotency rules.

## Shared call history

One shared history includes guided workflow requests, manual requests, and observed calls from the local LMNL backend. Each entry labels its source. Guided requests are grouped by workflow run and step; the user can filter by source and inspect any entry.

Observed LMNL calls show what happened. They receive a pass/fail result only when an expected outcome has been defined. This preserves the distinction between observing an application call and checking it against a test expectation.

The user can explicitly clear the workbench history. Clearing history removes workbench history records without changing Events, Orders, Tickets, Admissions, or other operational data. Resetting local test data is the separate control described below, agreed in [issue #60](https://github.com/fvckzest/HP-OS/issues/60). History storage and retention follow the [persistent evidence and export rules](#persistent-evidence-and-export) below.

## Protected values

Ordinary request fields are visible. Credentials and access tokens remain masked in request details and history. A protected value is represented by a descriptive source label, such as “Ticket token from Issue Tickets,” rather than its usable raw value.

Execution can still use protected values without storing their raw values in history. Masking is a display and capture boundary, not a change to the request sent to HP-OS. Source labels retain the explanation of how the workflow obtained a value without exposing the secret.

## Customized requests

Request details can represent edits outside the plain fields, including deliberately invalid requests used to test API rejection. The workbench preserves the exact edit, marks the request as customized, and explains validation problems. Plain fields that cannot represent the edit are marked unavailable instead of silently rewriting or discarding it.

Representable edits remain synchronized between the two views. Protected values remain masked. This preserves deliberate API tests while making limitations of the guided fields explicit.

## Editing expectations

Expected outcomes are editable before execution. Editing a request preserves the existing expectation until the user explicitly changes it. The history records the expectation used for that execution alongside the actual result; later edits must not change the expectation recorded for an earlier execution.

For example, setting Ticket quantity to `0` can be paired with an expectation that the API rejects the invalid quantity and creates no Order. Manual requests can also have optional expectations. A request without a defined expectation remains an observation rather than a passed or failed check.

This makes intentional rejection tests explicit and prevents the workbench from changing a test's meaning merely because its request changed.

## Local test environment

The test-data and failure controls below operate only in the dedicated local test environment. API tests use the normal HTTP boundary against real local PostgreSQL. Controls must preserve authentication, Site isolation, validation, idempotency, concurrency, and other business rules being tested. They must not directly force an Order, Ticket, Admission, or job into a desired outcome.

These boundaries, agreed in [issue #60](https://github.com/fvckzest/HP-OS/issues/60), make local failures repeatable without replacing the behavior under test. They preserve the existing [API contract](api/api.md) and [background processing responsibilities](technology.md#background-processing).

## Sample data and explicit reset

Provide a small, known base dataset containing test Sites and sample Events. “Reset local test data” clears all operational data in the dedicated local test database and restores that dataset. It preserves workbench request history, with entries labeled by the dataset they belong to. Earlier entries remain historical evidence even when their operational records have been removed.

Starting a scenario never resets existing data automatically. Each run creates its own labeled records through normal API operations, including the preparation needed for the test. For example, a second-Admission rejection scenario creates an Order, simulates a successful payment report, issues a Ticket, and admits it before attempting Admission again. A scenario requiring the exact original starting state, such as competing Orders for the last available Ticket, requires an explicit reset first.

This separates deliberate cleanup from scenario execution and preserves data still under investigation. Resetting local data does not reset external provider or email-service records.

## Background processing controls

Background processing runs manually by default, with an optional automatic mode. A “Run background processing” control executes one processing cycle and shows its results. It uses the same bounded processing entry point as the scheduler. HP-OS processing and Site-owned processing remain separately identified; an HP-OS cycle cannot itself prove payment verification or email delivery by LMNL.

Manual execution lets the user inspect pending work before and after a cycle. Automatic execution supports complete workflow testing once the individual steps are understood.

## Controlled time

Simulated scenarios start at a known, frozen application time. Controls advance that time by a duration or to the next relevant deadline. Advancing time changes what the local application considers “now”; processing continues to follow the selected manual or automatic mode. Time advancement does not itself force expiration, release capacity, or mark work complete.

For example, advance just past a Reservation's 15-minute deadline, inspect the Order, run processing, and check the contract-defined result. An unresolved payment attempt must still preserve its capacity hold until the normal rules permit release. Controlled time avoids real waiting while preserving deadline and recovery rules.

## Repeated and concurrent requests

Provide separate controls to repeat the same request and to send a small group of requests concurrently. Repeating a request retains its idempotency key, so the test can check that no duplicate operation occurs. Concurrent requests keep their individual request details, keys, and results visible in history and exercise normal database-backed concurrency rules.

For example, two competing Admission requests for one Ticket must create exactly one Admission. These controls make duplicate and competing operations deliberate, inspectable tests rather than accidental repetitions.

## Interrupted operations

Guided scenarios provide named interruption points that explain where execution stops and how to resume or retry through normal application operations. They cover interruptions such as a committed operation whose response is lost, interrupted worker execution, and external dispatch before its outcome is recorded. An interruption must not substitute a fabricated business-state change for the operation under test.

For example, “Payment recorded, response lost” commits the payment report but drops its response. The workbench shows “Outcome unknown”; retrying the same request with the same idempotency key must not duplicate Tickets. An email sent before its outcome is recorded requires the normal verification path before another send. These points make recovery repeatable while retaining transaction, retry, and unknown-outcome safeguards.

## Simulated outcomes

Select a simulated outcome for the next relevant operation, with success as the default. Payment choices include successful, declined, processing, and unknown outcomes, represented through the normal Site reporting contract. Email choices include accepted, known sending failure, and unknown sending outcome. Simulate delivery reports separately because sending acceptance does not establish delivery.

Guided failure scenarios select the relevant outcomes and show them before execution. Every simulated result is clearly labeled. Simulations represent Site-owned integration behavior and submit normal reports; they do not cause HP-OS to call external services or bypass report validation. This makes failure selection simple without confusing simulated evidence with an actual integration result.

## Actual test integrations

Simulation is the default. Actual test integrations become selectable when the local LMNL backend has the required test configuration. Payments use the provider's test environment; actual email tests use an explicitly configured test recipient. Credentials remain on the Site backend under the existing [ownership rules](ownership.md#external-service-credentials).

Each run identifies which services are simulated and which are actual. Runs using actual integrations use real time, since external services do not follow the controlled application clock. For example, a provider test payment with simulated email can establish the payment test journey but cannot establish actual email delivery.

Reset and interruption controls cannot erase an external service's effects. Simulation and local API results do not replace required actual payment, email, Wallet, device, hosted, or production evidence in the [release procedure](release-and-cutover.md).


## Consolidated specification

The completed workbench map is synthesized in [HP-OS local API workbench implementation specification](https://github.com/fvckzest/HP-OS/issues/66). It records user stories, implementation and testing decisions, and scope. Execution remains in the already amended first-release implementation tickets, starting with [Run HP-OS locally with persistent PostgreSQL](https://github.com/fvckzest/HP-OS/issues/23). This document retains the settled workbench rules; publication of the specification does not implement or verify them.

## Delivery and implementation handoff

The product owner confirmed this plan in [Settle incremental workbench delivery and verification](https://github.com/fvckzest/HP-OS/issues/61). Amend the existing first-release implementation tickets rather than creating separate workbench implementation tickets. Workbench requirements travel with the capability they inspect, preserving the implementation sequence and native dependencies.

### Location, startup, and access

Deliver a local-only `/workbench` page inside the planned HP-OS Next.js application. Provide one documented command that starts the required local services and prints the URL, plus clear service/configuration status and actionable startup errors. The initial command must work without an implemented local LMNL integration; show LMNL as unavailable until its corresponding capability arrives. Document first-time prerequisites separately.

Explicitly enable the workbench through this local command; bind its viewer and local HTTP targets to loopback and verify the dedicated local test database before enabling controls. Refuse hosted/production targets and redirects to them. Local handlers require a local access check and valid Host/Origin; Site keys stay in the server environment. These handlers are development controls, not new business endpoints or a production staff-login system. Manual and guided requests execute the existing API over HTTP with normal authentication and business rules. Workbench tables cannot become operational authority.

### First useful slice

[Run HP-OS locally with persistent PostgreSQL](https://github.com/fvckzest/HP-OS/issues/23) delivers the page, startup command, service status, editable manual request runner, sanitized shared history, storage across restart, explicit history clearing, and masked JSON export. It also establishes the catalogue and capture mechanism for later additions. Where a business endpoint does not yet exist, expose its unavailable status rather than inventing a testing endpoint or reporting a passed business check. Site authentication/configuration and durable processing become testable with their existing foundation tickets.

### Shared catalogue and capability status

Keep a shared, version-controlled catalogue of request templates and guided workflow steps. Each entry identifies its explanation, plain fields and request details, expected outcomes, operational observations and their sources, values shared between steps, preparation, and required capabilities/configuration. Add entries with the relevant endpoint or workflow implementation; keep the catalogue aligned with the API contract and [coverage index](research/local-api-workflow-testing-coverage.md).

Separate capability availability from execution results. Show **Unavailable** with the missing implementation, **Blocked** with the missing configuration/service or other prerequisite, and **Not run**, **Passed**, **Failed**, or **Interrupted** for execution state. Missing responses show **Outcome unknown**; absent capture is a separate evidence gap. Neither an absent capability nor an expected rejection is automatically a failed check. Disable execution that lacks its prerequisites and explain how it becomes available.

### Additions by implementation stage

| Stage | Workbench additions delivered with existing tickets |
| --- | --- |
| Foundation | Site access/configuration and isolation requests; durable-job reads, claims and reports; separate HP-OS/Site processing observations; repeat, concurrent, and interruption controls as the operations arrive. |
| Public single-Ticket | Event preparation and publication, sales controls, quotes and Orders, Site-owned checkout and payment reports, issuance, initial email, buyer access and Admission. Build a guided complete purchase and repeat-Admission rejection scenario; distinguish simulated API behavior from the connected LMNL/provider-test journey. |
| Recovery, refunds, and totals | Controlled deadlines, unresolved/conflicting payment and capacity holds, issuance/email recovery, Order recovery and email correction, Event changes/cancellation, provider-reported refunds, fees/totals, historical payment connections, and unattended worker recovery. Add named interruptions and safe recovery paths to the operation that needs them. |
| Private Events and Wallet | Access Request preparation/decisions, one paid purchase per approval, purchaser/attendee separation, unsigned Wallet data and durable updates. Expose actual signing/device checks only when the Site integration and device prerequisites are ready. |
| Public multi-Ticket | Extend the already verified one-Ticket workflow to quantities 1–8, complete atomic issuance, independent Ticket access/Admission, capacity races, and appropriate rejection checks. |
| Release verification | Export revision/environment-specific local evidence for the release checklist. Hosted test and controlled real purchase/refund evidence still come from their approved environments and actual integrations; the local workbench neither operates on those databases nor grants approval to open sales. |

Every applicable ticket includes request/catalogue entries, relevant before/after observations, success and expected-rejection scenarios, applicable retry/concurrency/interruption checks, and functional acceptance checks. Complete journeys grow only as their prerequisites arrive; do not rearrange implementation dependencies or expand the business contract.

### Persistent evidence and export

Store sanitized call history and workflow results in dedicated workbench tables in local PostgreSQL, separate from operational tables and durable business jobs. Retain them across application restart and operational test-data reset, until the user explicitly clears workbench history. Do not automatically age out entries. Operational reset must exclude these tables and preserve dataset labels; old references remain historical observations even after the associated operational records are removed.

Record the source, run/step and attempt identifiers, dataset, repository revision, environment, per-service integration mode, request/response evidence, expectation used at execution, actual result, and observation provenance. Use the HP-OS response-envelope request identifier separately from Access Request domain identifiers. Exports are masked JSON snapshots of this evidence and its completeness markers. They contain no usable credentials, access tokens, QR payloads, or secret-bearing URLs. Protect before persistence/export, including nested bodies, paths, headers, and diagnostic errors.

Use bounded capture that visibly marks truncation or excluded fields and does not consume the application's usable response. History is diagnostic evidence; it must not participate in the business transaction or change its commit/rollback outcome. The initial implementation does not require a separate tracing service, collector, or new cross-service tracing header. Capture manual/guided requests and HP-OS HTTP handling first; add actual local LMNL client and worker observations with the relevant Site capabilities. Correlate by returned HTTP request IDs and explicit run/job/domain links, show missing sides, and exclude workbench history polling from automatic capture. Labels must distinguish actual LMNL code from direct simulated requests.

This PostgreSQL history choice supersedes the research proposal for a separate JSONL trace store and automatic seven-day/100 MB deletion in [local call tracing](research/local-call-tracing.md). The research remains evidence, not an alternative implementation instruction.

### Capture failures and interrupted runs

If recording fails, finish the API operation normally and show **History capture incomplete**. Never retry a business operation because recording failed. If storage cannot save the failure marker, expose degraded capture through the running workbench/process diagnostics; after an abrupt stop, retain an explicit capture gap rather than claiming every attempt was recorded. A check cannot pass when its required response or state evidence is missing.

Preserve recorded results after restart and mark unfinished workflows **Interrupted**. Do not automatically resume or resend. Explicit recovery inspects current API state, respects same-request idempotency and external verification rules, and obtains protected values again from an authorized source or asks for them when needed. History snapshots alone cannot reconstruct a secret-bearing request. If the original request/key cannot be recovered safely, block that retry rather than create a replacement operation.

### Functional acceptance checks

Use observable outcomes through the two approved [testing boundaries](https://github.com/fvckzest/HP-OS/issues/22), not private functions or SQL structure as business proof:

- One command starts the initial local slice and prints its URL. Missing services/configuration produce useful status; hosted/production controls are inaccessible and hosted targets/database configuration are refused.
- Manual requests and available guided steps exercise normal HTTP authentication, validation, Site isolation and business rules against real test PostgreSQL. Capture actual local LMNL calls when the Site capability exists and label their source correctly.
- Field/request synchronization preserves deliberate customized invalid requests. Shared values and retry keys remain inspectable; expectations are snapshotted per execution. Unexpected results pause continuous execution, while correct expected rejections pass.
- Responses and relevant public/admin state observations expose expected/actual results and evidence provenance. Missing responses/observations and capture failures cannot produce a false pass.
- History/results survive application restart and operational reset, retain dataset/revision/environment labels, and export as masked JSON. Clearing history leaves business records unchanged; operational reset preserves history.
- Interrupted workflows do not resume automatically. Recovery checks current API state and respects original idempotency/verification rules. Lost responses and storage failures do not duplicate Orders, Tickets, Admissions, or dispatches.
- Exercise nested/path/header secret redaction, malformed bodies, truncation, unavailable storage and interrupted capture. Business outcomes remain unchanged, and evidence gaps are visible.
- Each added capability brings its catalogue entries and relevant success/rejection/recovery checks. Unimplemented or unconfigured steps explain their availability; configured actual integrations remain distinct from simulations.

Controlled time, reset, background processing, repeat/concurrent requests and named interruptions follow the settled controls above. Business acceptance checks use real local PostgreSQL and the scheduler's bounded processing entry point. Complete LMNL journeys still require the relevant actual services and devices. No visual review is included, and publishing this handoff is not runtime verification or release approval.

## Related planning

Test data and failure controls were agreed in [issue #60](https://github.com/fvckzest/HP-OS/issues/60); workbench delivery and persistence were agreed in [issue #61](https://github.com/fvckzest/HP-OS/issues/61). Planned scenario coverage is indexed in the [local testing coverage research](research/local-api-workflow-testing-coverage.md). These decisions preserve the existing [API contract](api/api.md). They do not implement a workbench or establish actual integration, hosted, or production readiness.
