# Local testing workbench

This document records local workbench decisions agreed with the product owner in [Choose the simplest beginner-friendly testing workflow](https://github.com/fvckzest/HP-OS/issues/58), under [Plan the HP-OS local API workbench](https://github.com/fvckzest/HP-OS/issues/56). The workbench is planned, not implemented.

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

The user can explicitly clear the workbench history. Clearing history removes workbench history records without changing Events, Orders, Tickets, Admissions, or other operational data. Resetting local test data is a separate control to be decided in [issue #60](https://github.com/fvckzest/HP-OS/issues/60). History storage and retention details belong to [issue #61](https://github.com/fvckzest/HP-OS/issues/61).

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

## Related planning

Test data and failure controls belong to [issue #60](https://github.com/fvckzest/HP-OS/issues/60); delivery and persistence belong to [issue #61](https://github.com/fvckzest/HP-OS/issues/61). These workflow decisions preserve the existing [API contract](api/api.md). They do not implement a workbench or establish actual integration, hosted, or production readiness.
