# Local testing workbench

This document records local workbench decisions agreed with the product owner in [Choose the simplest beginner-friendly testing workflow](https://github.com/fvckzest/HP-OS/issues/58) and [Decide repeatable test data and failure controls](https://github.com/fvckzest/HP-OS/issues/60), under [Plan the HP-OS local API workbench](https://github.com/fvckzest/HP-OS/issues/56). The workbench is planned, not implemented.

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

The user can explicitly clear the workbench history. Clearing history removes workbench history records without changing Events, Orders, Tickets, Admissions, or other operational data. Resetting local test data is the separate control described below, agreed in [issue #60](https://github.com/fvckzest/HP-OS/issues/60). History storage and retention details belong to [issue #61](https://github.com/fvckzest/HP-OS/issues/61).

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

## Related planning

Test data and failure controls were agreed in [issue #60](https://github.com/fvckzest/HP-OS/issues/60); workbench delivery and persistence belong to [issue #61](https://github.com/fvckzest/HP-OS/issues/61). Planned scenario coverage is indexed in the [local testing coverage research](research/local-api-workflow-testing-coverage.md). These decisions preserve the existing [API contract](api/api.md). They do not implement a workbench or establish actual integration, hosted, or production readiness.
