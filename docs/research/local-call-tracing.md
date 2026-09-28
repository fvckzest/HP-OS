# Local call tracing workbench

Research for [issue #59](https://github.com/fvckzest/HP-OS/issues/59), 2026-09-28.

**Status: proposal only.** This note records a small local workbench architecture for tracing manual and actual LMNL calls. It does not settle HP-OS product behavior, add an API contract, authorize a deployment, or implement instrumentation. The words “should” and “proposed” describe research recommendations for a later implementation decision.

## Settled implementation guidance

The product owner subsequently settled delivery and persistence in [Settle incremental workbench delivery and verification](https://github.com/fvckzest/HP-OS/issues/61). Follow the [local workbench handoff](../local-workbench.md#delivery-and-implementation-handoff): a local-only HP-OS page, dedicated local PostgreSQL history tables, retention until explicit history clearing, and incremental additions in existing implementation tickets. That decision supersedes this note's proposed separate JSONL store and automatic seven-day/100 MB deletion. The initial version requires no separate collector or new tracing header. Preserve the research findings on redaction, correlation limits, Site credential custody, and failure isolation; detailed instrumentation choices must satisfy the settled functional checks.

## Evidence boundary

The repository is still a planning repository. Its technology document proposes one Next.js application with a TypeScript API, direct SQL, and durable PostgreSQL work; it does not prove that a Next.js runtime, collector, LMNL integration, or worker currently exists ([technology](../technology.md)). The API contract is the current source for wrapper fields, retries, domain identifiers, notification jobs, and credential custody; it explicitly says that the endpoints and integrations are not implemented or verified ([API contract](../api/api.md)). No hosted request, production database, payment provider, email provider, or visual review was inspected.

The external evidence below is limited to primary sources: official Next.js documentation, OpenTelemetry specifications and documentation, W3C Trace Context, and the OWASP Logging Cheat Sheet. Their recommendations are separated from HP-OS facts and from the proposed design.

## Current HP-OS facts that the workbench must preserve

- A Site backend calls HP-OS over the private Site API key. Browsers call the Site; they do not call HP-OS directly. HP-OS keeps no Site or organization payment, email, or Apple Wallet credentials ([API boundary](../api/api.md#backend-access), [ownership](../ownership.md#external-service-credentials)).
- A successful API response contains `data` and the JSON envelope `request_id`; list responses also contain `pagination`. An error contains `error` and the same envelope `request_id`. `request_id` is an HTTP tracing identifier, not the Access Request record ID ([success format](../api/api.md#success-response-format), [error format](../api/api.md#error-response-format), [reference](../api/api-ref.md#response-envelopes)).
- A URL such as `/v1/admin/access-requests/{request_id}` uses `request_id` for the Access Request domain record. The response envelope’s `request_id` has a different meaning. A workbench must use separate field names for them.
- A request may be retried after a network failure or `429`, `500`, or `503`; the Site reuses the same `Idempotency-Key` and observes `Retry-After` where supplied. A matching replay is kept for seven days after completion ([safe retries](../api/api.md#safe-retries)).
- Notification work is durable. A job has `job_id`, kind, status, related Event/Order/Access Request/Ticket IDs, `attempt_count`, `available_at`, `requires_verification`, provider references, and payload. Claims have a separate lease identity. Unknown or expired dispatches require provider or dispatch-log verification before a resend ([notification jobs](../api/api.md#notification-job-schema-and-recovery), [job reference](../api/api-ref.md#notification-job-and-claim)).
- Jobs are saved with their triggering change; claim-time workers recheck current eligibility and payload versions. HP-OS owns the operational record and Site backends execute credential-dependent integrations. A trace store must remain diagnostic evidence and must not become an alternate business-state authority.

## Primary-source findings

Next.js provides `instrumentation.ts`/`.js` at the project root or `src` level. Its `register` function runs once when a server instance starts and must complete before requests are handled. `onRequestError` can report captured server errors; asynchronous work in that hook must be awaited, and the error may be a processed error with a digest ([instrumentation reference](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation)).

Next.js supports OpenTelemetry instrumentation and already emits framework spans. Its guide describes a root request span, route-handler and `fetch` spans, custom spans through `startActiveSpan`, and a local collector or compatible backend for testing. The guide recommends conditional Node-only loading when using `NodeSDK`; this is relevant to a later runtime choice, not a decision for this note ([OpenTelemetry guide](https://nextjs.org/docs/app/guides/open-telemetry)).

OpenTelemetry `Context` carries execution-scoped values so child work can use the active span. Instrumentation libraries normally propagate context automatically; manual propagation uses the API to inject and extract a carrier when automatic support is unavailable ([JavaScript context](https://opentelemetry.io/docs/languages/js/context/), [JavaScript propagation](https://opentelemetry.io/docs/languages/js/propagation/)).

OpenTelemetry distinguishes request/response `CLIENT` and `SERVER` spans from deferred `PRODUCER` and `CONSUMER` spans. A producer may finish before its consumer starts. Span links connect related spans in the same or another trace, and links are useful when the later operation cannot be made a child of the original span ([Tracing API](https://opentelemetry.io/docs/specs/otel/trace/api/#spankind), [links](https://opentelemetry.io/docs/concepts/signals/traces/#span-links)).

W3C Trace Context standardizes `traceparent` and optional `tracestate` for HTTP propagation. It says the fields exist for trace correlation and must not carry personally identifiable or other sensitive information ([W3C Trace Context](https://www.w3.org/TR/trace-context/)). The current HP-OS API contract does not define a caller-supplied trace header; adopting or forwarding one is a later implementation/API compatibility question. This proposal does not invent an `X-Request-ID` contract.

OWASP recommends an interaction identifier, timestamps, source, action, result, HTTP status, and enough context for analysis; it also recommends sanitizing event data before recording it. Its exclusions include session identifiers, access tokens, passwords, database connection strings, encryption keys, payment data, and sensitive personal data. Logging failures must not prevent the application from running, and verification should test disk exhaustion and logging-system failure ([Logging Cheat Sheet: attributes and interaction identifiers](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#event-attributes), [data to exclude](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude), [event collection and failure isolation](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#event-collection), [verification](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#verification)).

## Smallest proposed workbench

Reuse the planned Next.js application for the local viewer and server-side manual runner; no separate application or collector is necessary for the first useful slice. The viewer would call local-only workbench handlers, which call the existing `/v1` operations over HTTP instead of bypassing authentication or business rules. A dedicated test Site key would stay in the local server environment. This local access mechanism is proposed, not a new business API or HP-OS staff role. The LMNL backend remains a separate Site process.

The smallest useful design is one local call runner, one redaction step, and one bounded local trace store. The runner can operate in two explicit modes:

1. **Manual mode** sends a known request directly to a local HP-OS endpoint and labels the caller source `manual`.
2. **Actual LMNL mode** observes calls made by the running local LMNL backend, including calls outside a guided workbench run. It labels the caller source `lmnl`. It must not pretend that a direct HP-OS fixture call is evidence of an LMNL call.

Record integration mode separately for each payment, email, or Wallet step: `simulated`, `provider_test`, `live`, or `unknown`. A call from actual LMNL code can still use a simulated provider; source and integration mode are different evidence. Local traces do not prove hosted readiness, inbox delivery, device updates, or settlement. A manually submitted payment report is simulated verification evidence even when HP-OS stores a paid result.

Each run gets a workbench `run_id`. Each network attempt gets a `call_id`, including each retry. If OpenTelemetry is enabled, the runner also records `trace_id` and `span_id`. The response envelope’s HP-OS `request_id` is recorded as `hpos_request_id` only after a safe JSON parse. Domain and durable identifiers retain their own names:

| Identifier | Meaning | Source or proposal |
| --- | --- | --- |
| `run_id` | One selected manual or LMNL workflow execution | Proposed workbench ID |
| `call_id` | One attempted HTTP exchange, including retry attempts | Proposed workbench ID |
| `trace_id`, `span_id` | OTel trace graph identifiers | OTel, when enabled |
| `hpos_request_id` | Response-envelope HTTP request identifier | Existing HP-OS contract |
| `access_request_id` | Access Request domain record identifier | Existing HP-OS contract |
| `job_id` | Durable notification work identity | Existing HP-OS contract |
| `order_id`, `ticket_id`, `event_id` | Domain records | Existing HP-OS contract |
| `version`, `data_version` | Domain/payload version evidence where returned | Existing contract fields |

The runner should create the request span before preparing the network request, keep the span active through the response body read, and end it after the capture record is sanitized. A custom span can wrap the logical Site-to-HP-OS call; an automatically generated `fetch` span may represent the actual network exchange. The runner should avoid duplicate instrumentation if Next.js fetch instrumentation is enabled.

### Capture points and visibility limits

| Capture point | Existing response evidence | Additional instrumentation proposed |
| --- | --- | --- |
| Manual runner and LMNL HP-OS client | Status, envelope request ID, returned records/errors | Start/end, timeout, retry number, safe request/response shape, caller source |
| HP-OS `/v1` handler wrapper | Response result; no server timing in the contract | Generate/link the envelope request ID at entry; capture validation/authentication failures, server duration, response completion, sanitized exception class |
| HP-OS business transaction | Returned status/version or later reads | Record committed record/version and queued job relationships after commit; distinguish rollback from completion; do not log a proposed change as committed |
| HP-OS scheduled processing | Durable operational state; no generic worker trace endpoint | Batch start/end, idle batch, claim, attempt, retry scheduling, lease expiry and interruption, linked to durable work ID |
| LMNL integration adapters and workers | HP-OS knows only what LMNL reports | Checkout creation/closure, verified webhook receipt, provider recheck, report outbox retries, email acceptance/delivery verification, Wallet signing/update attempt; safe references and outcomes only |

Automatic Next.js spans cannot establish domain state changes or observe another process's integrations by themselves. Framework errors supplement the handler wrapper; `onRequestError` is not a complete call-history mechanism. The observer should exclude its own history reads to avoid recursively capturing diagnostic polling. The capture list above is an architectural inference from the existing responsibilities and framework hooks.

## Safe HTTP capture timing and contents

Before sending, capture a bounded, normalized record containing the local source label, method, route template, selected query parameters, request timestamp, timeout, attempt number, and a sanitized request summary. Do not persist a raw URL: tokens commonly occur in paths and query strings. Record an allowlisted header map and body media type/byte length. For JSON, parse and redact before storing a bounded shape or selected fields; for other media, store type, length, and a digest or truncation marker rather than arbitrary bytes.

Use UTC timestamps for display and a monotonic clock for duration within each process. Cross-process clock ordering is approximate; identifiers and explicit links establish relationships. Treat supplied trace/run identifiers as untrusted bounded diagnostic metadata. They must never choose a Site, authorize a request, or override the Site key and idempotency rules.

After receiving headers, capture header-arrival timestamp, elapsed time, status, and selected response headers. After the body completes, capture completion time, total duration, and measured byte length. Read or clone the bounded body without consuming the application's usable response, then record only a sanitized JSON summary. Preserve `hpos_request_id`, stable `error.code`, `error.details[].field` names, domain IDs, status, and safe state/version fields when present. Apply redaction before a logger, exporter, UI, or file write; the UI must not be the security boundary.

When `fetch` throws before headers, record an incomplete exchange with a phase where known, safe error class/code, elapsed time, and no HTTP status. A body-read failure retains the already received status and marks the body incomplete. Do not claim a precise connection phase when the runtime does not expose it. A network exception is not an HP-OS `500`, and a missing response cannot provide an HP-OS `request_id`. Record a separate `call_id` for a retry while retaining the same run and action correlation. Preserve the contract’s idempotency key behavior; a trace failure must never cause the runner to generate a new business action key.

Proposed initial limits are a 64 KiB sanitized body, bounded JSON depth and array lengths, and a 100 MB or seven-day local store limit, whichever is reached first. The implementation should make truncation explicit and delete oldest trace records first. These are safe defaults for implementation review, not settled retention policy.

## Durable state and deferred jobs

The workbench should extract `job_id`, related domain IDs, `claim_id`, provider message/event references, `version`/`data_version`, and the HP-OS envelope `request_id` from each relevant response. It should record the relationship as evidence attached to the call/span, while leaving HP-OS state and job tables authoritative.

For work that continues after the initiating HTTP request, the proposed graph is a producer span for the request that enqueues or returns the durable job, a consumer span for the claim/dispatch worker, and a span link carrying the producer context when the original span has ended. `job_id` is the durable correlation key; `claim_id` identifies a lease and must not replace it. This follows OpenTelemetry’s producer/consumer and link semantics.

Each attempt needs its own span and recorded result. An ended parent does not prevent later child spans; a new linked trace per deferred attempt is proposed to keep long-running recovery understandable. Save sanitized job-to-origin context in the local trace store and reload it after restart. Missing or expired context leaves a partial graph joined by durable domain/job IDs. Never rely on in-memory context to recover business work. Uninstrumented LMNL calls have no reliable workbench `run_id`; join client/server records by returned `hpos_request_id`, or optional validated trace context, and show any missing side explicitly. Time proximity and a shared Order ID alone do not prove causation.

A later `GET` or admin recheck can show current state, but an observer read-after is not proof that the earlier call caused the exact observed transition. The workbench should label evidence as `response`, `read_after`, or `transaction_linked`. The strongest future implementation evidence would be a transaction-committed transition marker or a returned state/version that HP-OS records atomically with the triggering change. Until then, the UI should say “observed after” rather than “caused by” when correlation is inferred.

Interrupted runs should end as `interrupted`; in-flight calls with no response should be `unknown`, not `failed`. Recovery should use the existing idempotency key and the API’s read/recheck/job verification rules. An unknown notification dispatch must follow the existing provider/dispatch-log verification rule and must not be blind-resubmitted because the trace is incomplete.

## LMNL instrumentation and credential custody

The capture point should be the local LMNL server’s HP-OS client boundary, after LMNL authorization and before the HP-OS request, with a second point at response/error completion. This proves which calls the Site made. A manual runner calling HP-OS directly is useful for endpoint diagnosis but is different evidence and must remain labeled `simulated`.

If both local services use OpenTelemetry, the later implementation may propagate W3C trace context across the LMNL-to-HP-OS boundary. If they cannot share context, the workbench can still correlate by `run_id`, `call_id`, and returned `hpos_request_id`, but should label the result as observed correlation. No propagation header should be added to the public contract without a separate decision.

Provider calls stay inside LMNL adapters. Record only adapter operation, duration, safe provider status/error code, attempt/job/connection IDs, and non-secret provider references. LMNL verifies callbacks and links them by recorded payment/message identity; a provider callback does not necessarily return the originating trace context. Do not forward local tracing baggage to providers. A successful Wallet signing step does not prove an iPhone received an update, and provider email acceptance is separate from confirmed delivery.

LMNL’s Site API key remains in its server-side environment. Provider access tokens, email credentials, Apple signing keys, cookies, and buyer access tokens remain outside the workbench store. The workbench should record service labels and non-secret references, never credential values or provider request bodies. A local trace exporter should be disabled by default so no capture is sent to a remote collector accidentally.

## Redaction and allowlist

The proposed store is allowlist-first. Keep method, route template, status, duration, media type, byte lengths, safe error codes, `hpos_request_id`, domain IDs, job/version fields, source provenance, and bounded timestamps. Keep `Retry-After` when present because it explains retry behavior. Store `Idempotency-Key` as a one-way local digest or omit it; never store the raw value.

Redact request and response headers named `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `api-key`, `password`, `secret`, `private-key`, `access-token`, `refresh-token`, and any provider credential header. Treat unknown headers as excluded by default. Trace IDs are random correlation values; `tracestate` is opaque and should be excluded unless a later implementation explicitly sanitizes it.

Redact these JSON and URL paths before persistence, case-insensitively and recursively: `order_token`, `ticket_token`, `access_request_token`, `recovery_token`, `approval_token`, `qr_payload`, `token`, `*_token`, `authorization`, `api_key`, `access_token`, `refresh_token`, `password`, `secret`, `private_key`, `signature`, and `code`/`state` values in callback URLs. Exclude raw query strings, access URLs, signed URLs, cookies, and error stacks containing request data. Names, email addresses, addresses, and payment details should be removed or replaced with field-presence markers unless a later approved test specifically requires a safe fixture value.

Redaction must be tested with nested payloads, arrays, URL path/query tokens, malformed JSON, duplicate headers, and exception messages. It should fail closed when a body cannot be parsed or a field cannot be classified. OWASP’s logging guidance supports sanitization, excluding access/session credentials and sensitive personal data, and protecting local log files.

Automatic instrumentation also needs this policy: Next.js fetch spans may contain `http.url` and span names with URLs. Disable unsuitable automatic capture or sanitize attributes, names, events, and exceptions before any exporter writes them. Sanitizing only custom call records would leave a second leakage path. Keep operational error codes while excluding unclassified free-text provider errors and stack messages.

## Local-only enablement, persistence, and failure behavior

The workbench should be disabled by default and require an explicit local environment flag such as `HPOS_LOCAL_TRACE=1`. It should refuse to start in production mode, refuse non-loopback HP-OS/LMNL targets, and keep records outside a web-served directory. Next.js defaults `next dev` and `next start` to `0.0.0.0`; a local-only run should explicitly bind `-H 127.0.0.1` ([Next.js CLI](https://nextjs.org/docs/app/api-reference/cli/next)). A future local viewer should require an additional local authorization check even when bound to loopback.

Local binding alone cannot prove data safety. The proposed startup checks should verify the configured database is the explicit local test instance, block hosted HP-OS/Site targets and redirects to them, and reject unexpected Host/Origin values and unauthenticated local mutations. Read-only capture must not provide a proxy for arbitrary credential-bearing requests. These controls need later functional verification and do not create a production administration interface.

Use one bounded JSONL file per process in a shared private local trace directory, with a single writer per file and a process-instance ID. The Next.js viewer can merge sanitized records by identifiers without adding an ingestion service or sharing Site credentials. Record start and completion separately so an abrupt stop can leave a visible unfinished attempt; a crash before a start record is flushed remains an explicit capture gap. Ignore a truncated final line on restart and report it. Do not put trace output in Git, the public `public/` tree, the HP-OS business database, or the durable job tables. The proposed default is seven days and 100 MB across the directory, with an explicit “delete all local traces” action. Trace retention and deletion are independent of Order, Ticket, Admission, payment, and notification-job history; deleting a trace must not delete or alter business state.

Capture and storage failures must not change the HP-OS or LMNL result. A bounded sink failure should mark the run/call as `capture_failed`, emit one safe diagnostic to the local process output, and continue the business request. It must not retry a business call. The implementation should have tests for collector unavailability, write permission failure, full disk, malformed body, timeout, process interruption, and redaction failure, following OWASP’s logging-failure and resource-exhaustion checks.

If storage itself fails, the marker may only exist in memory/process output; the viewer must show degraded capture rather than claiming every call was persisted. Transaction-linked diagnostics also remain best effort: the business transaction and required work must preserve their existing atomicity regardless of tracing. Store a run's revision/environment and expected versus observed outcome separately from diagnostic records; never promote a missing trace into a passing test.

## Alternatives and unresolved implementation questions

- **Structured JSONL only:** smallest dependency surface and easiest offline inspection; it provides run/call correlation but no automatic distributed trace graph.
- **In-memory OTel exporter plus JSONL snapshots:** retains OTel context and links while keeping the local store bounded; it is the smallest option that supports manual and actual LMNL graphs.
- **Local OpenTelemetry Collector:** aligns with Next.js local testing guidance and enables a trace UI, but adds another process, configuration, and failure surface. It should remain an optional later mode.

The proposed minimum is the Next.js viewer/runner plus structured process-local records; add OTel only where its context/links justify the setup cost. Full request inspection would show fields and redaction/truncation markers, with usable tokens kept only in server memory or Site custody for workflow execution. Persistent raw-secret inspection is not part of this proposal.

Before implementation, the project still needs decisions about local trace code location, Next.js version/runtime, W3C propagation, viewer access, body limits, retention, and transaction-linked evidence. Keep those choices in the workbench planning issues: [workflow and inspection #58](https://github.com/fvckzest/HP-OS/issues/58), [test data and failure controls #60](https://github.com/fvckzest/HP-OS/issues/60), and [delivery/persistence #61](https://github.com/fvckzest/HP-OS/issues/61), under [the workbench map #56](https://github.com/fvckzest/HP-OS/issues/56). This research completes #59's feasibility investigation and leaves those product decisions open.
