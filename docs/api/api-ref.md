# HP-OS API reference

Compact lookup sheet for the `/v1` API contract. The [full contract](api.md) defines validation, ordering, and recovery rules and identifies which portions have local implementation evidence; local evidence does not prove hosted operation. Contract decisions: [issue #10](https://github.com/fvckzest/HP-OS/issues/10) and the portfolio API contract in [issue #117](https://github.com/fvckzest/HP-OS/issues/117).

## Contents

- [Vocabulary](#vocabulary)
- [URL components](#url-components)
- [HTTP methods](#http-methods)
- [Endpoints](#endpoints)
- [Parameters](#parameters)
- [Headers](#headers)
- [HTTP statuses](#http-statuses)
- [Error codes](#error-codes)
- [Lifetimes and limits](#lifetimes-and-limits)
- [Data structures](#data-structures)
- [Request and response bodies](#request-and-response-bodies)

## Vocabulary



| Component | Definition |
| --- | --- |
| `API` | Rules for communication between programs. |
| `HTTP` | Protocol carrying a request and its response. |
| `REST` | Resource-oriented API design approach; not an HTTP method. |
| `resource` | Record or collection: Event, Order, Ticket, etc. |
| `endpoint` | HTTP method plus URL path identifying an operation. |
| `request` | Message LMNL sends to HP-OS. |
| `response` | Message HP-OS returns to LMNL. |
| `header` | Metadata outside the JSON body. |
| `body / payload` | Data carried inside a request or response. |
| `JSON` | Text format containing named fields and structured values. |
| `field` | Named value inside an object. |
| `schema` | Definition of field names, types, and constraints. |
| `enum` | Field accepting only specified values. |
| `authentication` | Verification of the calling Site key. |
| `authorization` | Permission to perform an operation; LMNL enforces admin permissions. |
| `idempotency` | Reusing an operation key returns the original result without repeating effects. |
| `cursor` | Opaque position used to request another list page. |
| `lease` | Temporary exclusive claim on notification work. |

## URL components

Shape: `https://<host>/v1/<namespace>/<resource>/<identifier>?<query>`; deployment hostname is not assigned here.



| Part | Meaning |
| --- | --- |
| `https://<host>` | Base URL; scheme and server address. |
| `/v1` | Contract version. |
| `/public` | Visitor-facing data; still requires backend Site authentication. |
| `/admin` | Operational data/actions; Site authorizes its users. |
| `/events` | Example collection path. |
| `/{event_id}` | Placeholder replaced by an actual identifier; braces are not sent. |
| `/actions/{action}` | Explicit business action on a record. |
| `?` | Starts the query string. |
| `&` | Separates query parameters. |
| `period=past` | Example query name/value pair. |

## HTTP methods



| Method | Meaning |
| --- | --- |
| `GET` | Read a record or list; no state change. |
| `POST` | Create, perform an action, or submit a report; manual lookup is a read-only exception. |
| `PATCH` | Edit supplied fields; omitted fields stay unchanged. |
| `PUT` | Register or replace a provider mapping, Collection membership, or ordered list. |
| `DELETE` | Remove a provider mapping, portfolio Photo, or Collection membership; guarded writes include JSON fields in the body. |

## Endpoints

Paths are relative to the base URL. `{...}` identifies a path parameter. All endpoints require a Site key. All writes require `Idempotency-Key`.

### Public reads

| Endpoint | Meaning |
| --- | --- |
| `GET /v1/public/events` | List published current/past Events. |
| `GET /v1/public/events/{event_id}` | Read one published Event. |
| `GET /v1/public/orders/{order_token}` | Read a purchase and all its issued Tickets. |
| `GET /v1/public/tickets/{ticket_token}` | Read one independently shareable Ticket. |
| `GET /v1/public/access-requests/{access_request_token}` | Read approved attendee and checkout eligibility. |
| `GET /v1/public/tickets/{ticket_token}/apple-wallet-data` | Read unsigned data for a buyer Wallet pass. |
| `GET /v1/public/artworks` | List published Artworks in active Collections; optional `collection_id`, `limit`, and `cursor`. |
| `GET /v1/public/artworks/{artwork_id}` | Read one eligible public Artwork by stable API ID. |
| `GET /v1/public/collections` | List active Collections in display order. |
| `GET /v1/public/collections/{collection_id}` | Read active Collection metadata. |
| `GET /v1/public/collections/{collection_id}/artworks` | List eligible Artworks in Collection order. |
| `GET /v1/public/media/{photo_id}/variants/{variant}` | Read public `grid_400` or `artwork_1600` WebP bytes; Site key required. |

### Public submissions

| Endpoint | Meaning |
| --- | --- |
| `POST /v1/public/events/{event_id}/quotes` | Quote one to eight public Tickets or one approved private Ticket; reject quantities above current availability with `sold_out` or `insufficient_capacity` without holding capacity. |
| `POST /v1/public/orders` | Create an unpaid public Order from a quote or a private Order from an approval token. |
| `POST /v1/public/events/{event_id}/access-requests` | Submit intended attendee details for approval. |
| `POST /v1/public/order-recovery` | Queue temporary Order links; generic acknowledgment. |

### Admin Event operations

| Endpoint | Meaning |
| --- | --- |
| `GET /v1/admin/events` | List Events, including drafts. |
| `GET /v1/admin/events/{event_id}` | Read Event configuration and operational state. |
| `POST /v1/admin/events` | Create an incomplete draft. |
| `PATCH /v1/admin/events/{event_id}` | Edit supplied Event/offering fields. |
| `POST /v1/admin/events/{event_id}/actions/{action}` | Publish, archive, cancel, stop sales, or resume sales using a guarded action. |
| `PUT /v1/admin/events/{event_id}/provider-mappings/{connection_id}` | Set a verified provider resource mapping. |
| `DELETE /v1/admin/events/{event_id}/provider-mappings/{connection_id}` | Remove a mapping for future Orders. |

### Admin portfolio operations

| Endpoint | Meaning |
| --- | --- |
| `GET /v1/admin/artworks` | List Artworks; optional `publication_status`, `original_status`, `collection_id`, `limit`, `cursor`. |
| `POST /v1/admin/artworks` | Create a draft Artwork. |
| `GET /v1/admin/artworks/{artwork_id}` | Read Artwork, ordered Photos, and Collection memberships. |
| `PATCH /v1/admin/artworks/{artwork_id}` | Edit supplied Artwork fields. |
| `POST /v1/admin/artworks/{artwork_id}/actions/{action}` | `publish` or `archive`. |
| `GET /v1/admin/artworks/{artwork_id}/photos` | List Photos, including processing and replacement states. |
| `POST /v1/admin/artworks/{artwork_id}/photos` | Upload one new Photo (`multipart/form-data`). |
| `POST /v1/admin/artworks/{artwork_id}/photos/{photo_id}/actions/retry` | Retry failed initial processing or a failed replacement on the same Photo ID. |
| `POST /v1/admin/artworks/{artwork_id}/photos/{photo_id}/replacement` | Begin a replacement for a ready Photo with no replacement attempt. |
| `DELETE /v1/admin/artworks/{artwork_id}/photos/{photo_id}` | Remove a Photo; a published hero removal requires a replacement hero in the request. |
| `PUT /v1/admin/artworks/{artwork_id}/photo-order` | Replace the full Photo order. |
| `PUT /v1/admin/artworks/{artwork_id}/hero` | Select one ready Photo as hero. |
| `GET /v1/admin/collections` | List active and inactive Collections. |
| `POST /v1/admin/collections` | Create a Collection at the end of the order. |
| `GET /v1/admin/collections/{collection_id}` | Read a Collection. |
| `PATCH /v1/admin/collections/{collection_id}` | Edit name, description, active state, or display position. |
| `GET /v1/admin/collections/{collection_id}/artworks` | List Artwork memberships in order. |
| `PUT /v1/admin/collections/{collection_id}/artworks/{artwork_id}` | Add a membership at the end; existing membership is unchanged. |
| `DELETE /v1/admin/collections/{collection_id}/artworks/{artwork_id}` | Remove a membership. |
| `PUT /v1/admin/collections/{collection_id}/artwork-order` | Replace the full Artwork order in a Collection. |

### Admin Orders, Tickets, and entry

| Endpoint | Meaning |
| --- | --- |
| `GET /v1/admin/events/{event_id}/orders` | List Event Orders. |
| `GET /v1/admin/orders/{order_id}` | Read one operational Order. |
| `GET /v1/admin/orders/{order_id}/payment-status` | Read current payment, issuance, delivery, and refund status without access tokens. |
| `GET /v1/admin/events/{event_id}/tickets` | List Event Tickets without page tokens or QR payloads. |
| `GET /v1/admin/events/{event_id}/totals` | Read consistent money, fee, and Ticket totals. |
| `POST /v1/admin/events/{event_id}/ticket-lookup` | Find Orders by reference or current delivery email; read-only. |
| `POST /v1/admin/events/{event_id}/admissions` | Record one entry by scanned token or selected Ticket ID. |
| `POST /v1/admin/orders/{order_id}/actions/{action}` | Retry issuance, resend email, or correct delivery email. |
| `GET /v1/admin/tickets/{ticket_id}/apple-wallet-data` | Read unsigned data for Wallet update work. |

### Admin Access Requests

| Endpoint | Meaning |
| --- | --- |
| `GET /v1/admin/events/{event_id}/access-requests` | List attendee requests. |
| `GET /v1/admin/access-requests/{request_id}` | Read one attendee request. |
| `PATCH /v1/admin/access-requests/{request_id}` | Correct pending attendee details. |
| `POST /v1/admin/access-requests/{request_id}/actions/{action}` | Approve, reject, or undo a decision. |

### Payment and fee operations

| Endpoint | Meaning |
| --- | --- |
| `GET /v1/admin/payment-configuration` | Read the active connection for new Orders. |
| `GET /v1/admin/payment-connections/{connection_id}` | Read assigned/historical non-secret connection metadata. |
| `GET /v1/admin/payment-attempts/{attempt_id}` | Read one Site-owned attempt without caching. |
| `GET /v1/admin/payment-attempts` | List attempts, including `requires_verification=true` recovery work and `requires_report_work=true` unapplied-report work. |
| `POST /v1/admin/orders/{order_id}/payment-attempts` | Record an attempt before calling the provider. |
| `POST /v1/admin/payment-attempts/{attempt_id}/checkout-reference` | Register provider checkout before the buyer opens it. |
| `POST /v1/admin/payment-attempts/{attempt_id}/payment-reports` | Report a Site-verified payment outcome. |
| `POST /v1/admin/payment-attempts/{attempt_id}/setup-failure` | Report verified setup failure and safe closure. |
| `POST /v1/admin/payment-attempts/{attempt_id}/closure-reports` | Confirm provider checkout cannot take payment. |
| `POST /v1/admin/payment-attempts/{attempt_id}/actions/resolve` | Resolve conflicting payment evidence with guarded verification. |
| `POST /v1/admin/orders/{order_id}/refund-reports` | Report a provider refund; does not initiate it. Returns `503 payment_not_confirmed` without saving evidence while the original payment is still unresolved. |
| `POST /v1/admin/orders/{order_id}/fee-reports` | Report actual processing/platform fee components. |
| `POST /v1/admin/orders/{order_id}/fee-confirmations` | Confirm complete fee amounts, including verified zero. |

### Notification operations

| Endpoint | Meaning |
| --- | --- |
| `GET /v1/admin/notification-jobs` | List durable notification work. |
| `GET /v1/admin/notification-jobs/{job_id}` | Read/recheck a job. |
| `POST /v1/admin/notification-jobs/claims` | Claim available jobs for five minutes. |
| `POST /v1/admin/notification-jobs/claims/{claim_id}/renew` | Extend the active claim lease. |
| `POST /v1/admin/notification-jobs/{job_id}/outcome-reports` | Report dispatch completed, failed, or unknown. |
| `POST /v1/admin/notification-jobs/{job_id}/delivery-reports` | Report provider-confirmed email delivery or failure. |

Claims and reports require a Site API key, a UUID `Idempotency-Key`, and a system `actor` object with a Site-local `reference`. Outcome reports also require the claimed job's current `lease_fence`; an old claim ID or fence returns `409 claim_conflict`.

### Action names

| Resource | Action | Meaning |
| --- | --- | --- |
| Event | `publish` | Make a valid draft publicly discoverable. |
| Event | `archive` | Archive an ended/canceled Event; retain history. |
| Event | `cancel` | Stop new Orders and Admission, retain uncertain payment holds, and queue paid-buyer notices; does not refund. |
| Event | `stop_sales` | Pause new checkout for an eligible published Event. |
| Event | `resume_sales` | Resume a paused Event when its window and capacity permit sales. |
| Artwork | `publish` | Publish a valid draft or republish an archived Artwork. |
| Artwork | `archive` | Hide a published Artwork while retaining its data and relationships. |
| Order | `retry_ticket_issuance` | Retry the complete Ticket set for verified payment. |
| Order | `resend_ticket_email` | Queue another email for existing Tickets. |
| Order | `correct_delivery_email` | Replace buyer page links and resend to a verified address. |
| Access Request | `approve` | Permit one paid Ticket and queue an approval email. |
| Access Request | `reject` | Reject the request without email. |
| Access Request | `undo_decision` | Return to pending; revoke approval access if applicable. |
| Payment attempt | `resolve` | Apply corrected verified evidence; retain history. |

The local Event handler supports `publish`, `archive`, `cancel`, `stop_sales`, and `resume_sales`. Event cancellation does not initiate refunds; the Site worker sends the durable `event_canceled` notifications. See the [full contract](api.md#admin-event-endpoints) for action rules.

## Parameters

### Path parameters

| Parameter | Meaning |
| --- | --- |
| `event_id` | Event record ID. |
| `order_id` | Order record ID; not a buyer access token. |
| `ticket_id` | Ticket record ID; used for authorized manual admission. |
| `request_id` | Access Request record ID in these paths; distinct from response tracing ID. |
| `attempt_id` | Payment attempt ID. |
| `connection_id` | Payment connection ID. |
| `job_id` | Notification job ID. |
| `claim_id` | Notification lease/claim ID. |
| `artwork_id` | Opaque Site-scoped Artwork API ID; not the displayed Artwork ID or a database ID. |
| `collection_id` | Opaque Site-scoped Collection API ID. |
| `photo_id` | Opaque Site-scoped Photo API ID. |
| `variant` | Delivery variant: `grid_400` or `artwork_1600`. |
| `action` | Supported action name for the resource. |
| `order_token` | Normal or temporary recovery access to a whole Order. |
| `ticket_token` | Access to one Ticket page. |
| `access_request_token` | Approval-link access for private checkout. |

### List filters and pagination

| Parameter | Applies to | Meaning |
| --- | --- | --- |
| `limit` | Lists; lookup/claims body | Page/claim size, 1–100; default 50. |
| `cursor` | Lists; lookup body | Next-page position; repeat original filters and size. |
| `period` | Public Events | current (default) or past. |
| `publication_status` | Admin Events | draft or published. |
| `visibility` | Admin Events | public or private. |
| `is_archived` | Admin Events | Archive flag; defaults false. |
| `is_canceled` | Admin Events | Cancellation flag. |
| `publication_status` | Admin Artworks | `draft`, `published`, or `archived`. |
| `original_status` | Artworks | `available` or `sold`; independent from publication state. |
| `collection_id` | Artwork list filters | Restrict results to one Site-scoped Collection. |
| `payment_status` | Orders | Filter payment state. |
| `issuance_status` | Orders | Filter Ticket issuance state. |
| `delivery_status` | Orders | Filter ticket-email state. |
| `refund_status` | Orders | Filter refund coverage. |
| `email` | Orders/Tickets/requests/lookup | Exact normalized email; attendee email for requests, current delivery email otherwise. |
| `order_reference` | Orders/lookup | Exact human-readable Order reference. |
| `admission_status` | Tickets | unused or admitted. |
| `can_admit` | Tickets | Current live entry eligibility. |
| `status` | Access Requests/jobs | Resource-specific status. |
| `kind` | Jobs list | One notification kind. |
| `kinds` | Claims body | Optional array of kinds to claim. |
| `event_id` | Attempts/jobs | Restrict to one Event. |
| `order_id` | Jobs | Restrict to one Order. |
| `requires_verification` | Attempts/jobs | Select unresolved provider outcomes. |

Event and portfolio list endpoints reject unknown or invalid parameters with `422 validation_failed`. Their cursors are signed using the current Site API key and bound to the Site, endpoint, filters, ordering, and page size; they remain valid for one hour. After rotating the Site API key, start pagination again. Invalid, expired, or mismatched cursors return `422 invalid_cursor`.

## Headers



| Header | Direction | Meaning |
| --- | --- | --- |
| `Authorization` | Request | Bearer <site_api_key>; backend-only Site authentication. |
| `Content-Type` | Request | `application/json`, or `multipart/form-data` for a portfolio upload with one `file` and one JSON `metadata` part. |
| `Idempotency-Key` | Write request | UUID for one intentional operation; reuse unchanged on retry. |
| `Retry-After` | Response | Seconds to wait for 429, temporary 503, or request_in_progress. |
| `Cache-Control` | Response | no-store for buyer access, operational reads, and Site-authenticated portfolio projections/media. |
| `X-Request-Id` | Response | HTTP tracing ID for raw WebP media responses, which do not use a JSON envelope. |

## HTTP statuses



| Status | Meaning |
| --- | --- |
| `200 OK` | Read/edit/action completed; portfolio mutation/removal completed; repeated source report accepted; public media read returns WebP bytes. |
| `201 Created` | New record, Admission, or newly recorded domain report; portfolio Artwork/Collection creation. |
| `202 Accepted` | Recovery, issuance retry, resend, or portfolio Photo upload/retry/replacement accepted for processing. |
| `400 Bad Request` | Unreadable JSON or malformed request. |
| `401 Unauthorized` | Missing, invalid, or revoked Site key. |
| `404 Not Found` | Record/token unavailable within the authenticated Site. |
| `409 Conflict` | Business-state, version, idempotency, or provider-evidence conflict. |
| `413 Content Too Large` | JSON body exceeds 64 KiB or portfolio upload exceeds its size limit. |
| `415 Unsupported Media Type` | Request encoding or uploaded image format is unsupported. |
| `422 Unprocessable Content` | Readable request with invalid fields/filter/cursor. |
| `429 Too Many Requests` | Site request budget exceeded. |
| `500 Internal Server Error` | Unexpected HP-OS failure. |
| `503 Service Unavailable` | Temporary dependency/configuration failure. |

## Error codes

Use `error.code` for program logic; use `error.message` for explanation. Retry network errors, 429, 500, 503, and the specific `request_in_progress` conflict with the same write key.



| Code | Meaning |
| --- | --- |
| `invalid_request` | Malformed request. |
| `validation_failed` | Invalid/missing field values. |
| `unauthorized` | Site key rejected. |
| `not_found` | Record/token unavailable; does not disclose other Sites. |
| `invalid_cursor` | Expired, invalid, or mismatched pagination cursor. |
| `request_too_large` | JSON body exceeds 64 KiB or portfolio image/multipart body exceeds its limit. |
| `unsupported_media_type` | Unsupported request encoding or an uploaded format other than JPEG, PNG, WebP, or TIFF. |
| `rate_limited` | Request budget exceeded. |
| `internal_error` | Unexpected server failure. |
| `service_unavailable` | Temporary service failure. |
| `payment_configuration_unavailable` | Complete checkout configuration/amounts unavailable. |
| `invalid_state` | Action is not allowed in the current state. |
| `version_conflict` | Record changed since the client loaded it. |
| `idempotency_conflict` | Key reused with a different method/path/body. |
| `idempotency_expired` | Replay result expired; operation will not repeat. |
| `request_in_progress` | Original same-key operation is still running. |
| `claim_conflict` | Claim expired or does not own the job. |
| `sales_not_configured` | Required sales settings missing. |
| `sales_configuration_locked` | A previously complete sales configuration cannot be cleared. |
| `sales_not_open` | Sales opening time has not arrived. |
| `sales_paused` | New checkouts manually stopped. |
| `sales_closed` | Sales window/Event ended. |
| `sold_out` | No remaining capacity. |
| `insufficient_capacity` | Some capacity remains, but less than requested. |
| `access_not_required` | The Event uses public checkout, so an Access Request or approval token is not accepted. |
| `quote_expired` | Quote lifetime elapsed. |
| `quote_changed` | Pricing changed; request a fresh quote. |
| `quote_already_used` | Quote already created an Order. |
| `access_checkout_in_progress` | This approval already has an active/unresolved checkout. |
| `access_already_used` | Approval already produced its paid purchase. |
| `payment_attempt_in_progress` | An existing attempt might still charge. |
| `order_already_paid` | Paid Order cannot start another attempt. |
| `checkout_expired` | Order payment-start window expired. |
| `checkout_ended` | Checkout permission terminated. |
| `provider_reference_conflict` | Provider reference conflicts with another attempt in the same Site. |
| `payment_report_conflict` | Payment evidence contradicts the recorded attempt. |
| `payment_not_confirmed` | Refund report must wait for the original payment outcome; retry with the same key. |
| `refund_report_conflict` | Refund evidence/amount contradicts the ledger. |
| `fee_report_conflict` | Fee revision or confirmation contradicts records. |
| `planned_platform_fee_discrepancy` | Confirmed platform fee differs from the planned checkout fee; the actual report remains authoritative. |
| `delivery_report_conflict` | Same provider delivery event has contradictory data. |
| `event_canceled` | Canceled Event blocks the operation. |
| `ticket_refunded` | Full refund prevents future Admission. |
| `already_admitted` | Ticket already has its one Admission. |
| `check_in_not_open` | Before the check-in opening instant. |
| `check_in_closed` | After the Event end instant. |
| `ticket_event_mismatch` | Ticket belongs to a different Event on this Site. |
| `publication_incomplete` | Artwork lacks an active Collection, complete ready Photo variants, or exactly one ready hero. |
| `slug_conflict` | Artwork slug is already assigned within the Site. |
| `image_invalid` | An accepted-format image is corrupt or cannot be decoded. |

## Lifetimes and limits



| Item | Value / behavior |
| --- | --- |
| Quote | 10 minutes; holds no capacity. |
| Order checkout | 15 minutes from creation; unresolved payment keeps capacity held. |
| Idempotency result | Replay for 7 days after completion; used keys remain remembered. |
| Cursor | 1 hour; bound to Site, endpoint, filters, ordering, and size. |
| Recovery access | 30 minutes; reusable during that window. |
| Order/Ticket page tokens | No automatic expiry; replaced after verified delivery-email correction. |
| Approval access | One paid Ticket; new checkout blocked when approval revoked or sales close. |
| Admission QR | Stable across resends, recovery, and delivery-email corrections. |
| Notification lease | 5 minutes; renewable. |
| Public quantity | 1–8 Tickets per Order. |
| Private quantity | Exactly 1 Ticket per Order. |
| List/claim size | Default 50; maximum 100. |
| JSON body | Maximum 64 KiB. |
| Portfolio image | One JPEG, PNG, WebP, or TIFF file up to 50 MiB; multipart metadata/envelope may add at most 64 KiB. |
| Temporary upload bytes | Abandoned incomplete bytes are removed within 24 hours; accepted source is deleted after its processing attempt. |
| Site request budget | Default 1,200/minute across keys; operator configurable. |
| Recovery emails | Coalesced to 1/minute and 5/hour per Site/email; generic response. |
| Request retry | Up to 5 retries with 1/2/4/8/16-second delays plus jitter; honor Retry-After. |

## Data structures

Notation: `T[]` = array of T; `T?` = T or JSON `null`; optional = may be omitted from input. Shapes below describe fields inside `data`, unless noted. Names such as `Money` are reference labels, not extra JSON wrapper keys.

### Primitive formats



| Format | Example | Meaning |
| --- | --- | --- |
| `string` | `"Evening Concert"` | Text; identifiers/tokens are opaque strings. |
| `integer` | `100` | Whole number within the JSON safe-integer range. |
| `boolean` | `true` | true or false; not quoted text. |
| `null` | `null` | Explicit missing/cleared value; not zero or an empty string. |
| `object` | `{"name":"Hall"}` | Named fields enclosed in braces. |
| `array` | `["a","b"]` | Ordered values enclosed in brackets; [] is empty. |
| `timestamp` | `"2026-10-11T02:00:00Z"` | RFC 3339 with explicit `Z` or numeric offset; whole-second values retain the suffix, and responses are normalized to UTC. |
| `time zone` | `"America/Los_Angeles"` | IANA time-zone name. |
| `currency` | `"USD"` | Uppercase currency code. |
| `UUID` | `"123e4567-e89b-42d3-a456-426614174000"` | Format used for Idempotency-Key. |
| `opaque access token` | `"<url-safe-token>"` | 32 random bytes encoded as a URL-safe string; purpose-specific. |

Text limits: name/title 200 characters; description 20,000; venue address 1,000; email 254. Names/titles are trimmed. Descriptions are plain text. Email matching trims whitespace and ignores case.

### Response envelopes

| Field | Type | Meaning |
| --- | --- | --- |
| `data` | object or array | Successful result; lists use arrays. |
| `pagination` | object; list only | Contains next_cursor. |
| `pagination.next_cursor` | string? | Next page token; null when finished. |
| `request_id` | string | HTTP tracing identifier; not the Access Request ID. |
| `error` | object; failure only | Structured failure instead of data. |
| `error.code` | string | Stable machine-readable reason. |
| `error.message` | string | Readable explanation. |
| `error.details` | FieldError[] | Field-specific errors; [] if none. |
| `error.details[].field` | string | Field path; e.g. starts_at or headers.Idempotency-Key. |
| `error.details[].code` | string | Field-specific validation reason. |
| `error.details[].message` | string | Field-specific explanation. |

### Money, fee entries, people, and venue

| Field | Type | Meaning |
| --- | --- | --- |
| `Money.amount` | integer | Minor units; USD 2500 means $25.00. |
| `Money.currency` | string | Currency for this amount. |
| `BuyerInput.name` | string | Purchaser name. |
| `BuyerInput.email` | string | Purchaser email. |
| `Person.name` | string | Identity/approved attendee name. |
| `Person.email` | string | Identity/approved attendee email. |
| `Venue.name` | string? | Venue display name; required for publication. |
| `Venue.address` | string? | Optional venue address. |
| `BuyerFee.code` | string | Buyer-facing fee identifier. |
| `BuyerFee.label` | string | Buyer-facing fee label. |
| `BuyerFee.amount` | integer | Nonnegative minor-unit charge. |
| `BuyerFee.currency` | string | Matches quote currency. |
| `Actor.type` | enum | user or system. |
| `Actor.reference` | string | Non-secret Site-local actor ID for audit attribution. |

### Event

| Field | Type | Meaning |
| --- | --- | --- |
| `event_id` | string | Event ID. |
| `title` | string? | Event title; draft may be incomplete. |
| `description` | string? | Plain-text Event description. |
| `venue` | Venue | Venue name/address. |
| `starts_at` | timestamp? | Event start. |
| `ends_at` | timestamp? | Event end; must follow start. |
| `time_zone` | string? | Event local display zone. |
| `check_in_opens_at` | timestamp? | Effective opening; null follows the current Event start after edits, while an explicit time stays fixed. |
| `visibility` | enum? | public or private; fixed after publication. |
| `purchase_mode` | enum | public_checkout or access_request. |
| `sales_status` | enum | canceled, closed, not_configured, scheduled, paused, sold_out, open. |
| `is_canceled` | boolean | Cancellation flag. |
| `is_archived` | boolean | Archive flag. |
| `ticket_offering` | Offering | Single priced sale option. |
| `version` | integer; admin | Current guarded record version. |
| `publication_status` | enum; admin | draft or published. |
| `created_at` | timestamp; admin | Creation instant. |
| `updated_at` | timestamp; admin | Latest update instant. |
| `sales_paused` | boolean; admin | Manual stop flag. |
| `check_in_uses_event_start` | boolean; admin | Opening follows Event start rather than an explicit time. |

### Artwork, Collection, and Photo

| Field | Type | Meaning |
| --- | --- | --- |
| `artwork_id` | string | Stable opaque Site-scoped HP-OS API ID; distinct from displayed ID and database IDs. |
| `slug` | string? | Site-facing Artwork reference; required before publication and unique within the Site. |
| `displayed_artwork_id` | string | Operator-visible Artwork identifier such as `X-0073`; independent from `artwork_id`. |
| `title` | string | Required Artwork title; maximum 200 characters. |
| `description` | string? | Optional plain text; maximum 20,000 characters. |
| `medium` | string? | Optional medium; maximum 200 characters. |
| `dimensions` | object? | `{width, height, unit}`; positive values, unit `mm`, `cm`, or `in`. |
| `created_on` | date? | Artwork creation date in `YYYY-MM-DD`. |
| `cardano_chain` | string? | Optional Cardano chain metadata; not verified by HP-OS. |
| `cardano_policy_id` | string? | Optional Cardano policy identifier. |
| `cardano_asset_id` | string? | Optional Cardano asset identifier. |
| `publication_status` | enum | `draft`, `published`, or `archived`; independent from sold status. |
| `original_status` | enum | `available` or `sold`; original-piece status, not print availability. |
| `collection_ids` | string[]; admin | This Artwork's Collection memberships. |
| `hero_photo_id` | string? | The one selected ready Photo, or null for an unpublished incomplete draft. |
| `AdminArtwork.photos` | `AdminPhoto[]` | All Photos in one-based order, including incomplete states. |
| `AdminArtwork.version` | integer | Guarded version for Artwork edits and actions. |
| `AdminArtwork` | object | `{artwork_id, slug, displayed_artwork_id, title, description, medium, dimensions, created_on, cardano_chain, cardano_policy_id, cardano_asset_id, original_status, publication_status, collection_ids, photos, hero_photo_id, version}`. |
| `collection_id` | string | Stable opaque Site-scoped Collection API ID. |
| `Collection.name` | string | Required trimmed name; maximum 200 characters. |
| `Collection.description` | string? | Optional Collection description. |
| `Collection.is_active` | boolean | Inactive Collections retain memberships but are hidden publicly. |
| `Collection.position` | integer | One-based display position; artwork positions are independent per Collection. |
| `Collection.version` | integer | Guarded version for Collection fields and membership order. |
| `AdminCollection` | object | `{collection_id, name, description, is_active, position, version}`. |
| `photo_id` | string | Stable opaque Site-scoped Photo API ID. |
| `Photo.position` | integer | One-based order within the Artwork. |
| `Photo.version` | integer | Guarded version for retry and replacement attempts. |
| `AdminPhoto` | object | `{photo_id, position, status, ready_variants, failure_code, retryable, replacement, version}`. |
| `AcceptedPhoto` | object | `{photo: AdminPhoto, artwork_version}` returned by upload, retry, and replacement. |
| `Photo.status` | enum | `processing`, `ready`, or `failed`; ready requires both variants. |
| `Photo.ready_variants` | string[] | Subset of `grid_400`, `artwork_1600`; admin status only. Public variants are WebP with longest edge up to 400 or 1,600 px and preserved aspect ratio. |
| `Photo.failure_code` | string? | `delivery_variants_failed` or null. |
| `Photo.retryable` | boolean | Whether an accepted failed attempt can be retried from the source copy. |
| `Photo.replacement` | object? | `{status, ready_variants, failure_code, retryable}` for an active or failed replacement; null otherwise. |
| `Photo.image_refs` | object; public | Stable `{grid_400, artwork_1600}` API-relative paths to public WebP variants. |
| `expected_artwork_version` | integer; membership input | Artwork version required with the Collection `expected_version`. |
| `CollectionArtwork` | object; admin list row | `{position, artwork: AdminArtwork}` for one membership in its Collection order. |
| `PublicArtwork` | object | `{artwork_id, slug, displayed_artwork_id, title, description, medium, dimensions, created_on, cardano_chain, cardano_policy_id, cardano_asset_id, original_status, collections, photos, hero_photo_id}`; no version or operational state. |
| `PublicCollection` | object | `{collection_id, name, position}`; its ordered public Artworks come from `/collections/{collection_id}/artworks`. |

### Ticket offering and provider mapping

| Field | Type | Meaning |
| --- | --- | --- |
| `price` | Money? | Base Ticket price; positive when set. |
| `max_quantity_per_order` | integer | 8 for public checkout; 1 for private approval checkout. |
| `tax_amount` | integer?; admin | Explicit tax per Ticket in minor units; null means unknown, zero means confirmed none. |
| `buyer_fees` | BuyerFee[]?; admin | Explicit buyer-fee list; null means unknown, [] means confirmed none. |
| `offering_id` | string; admin | Sale-option ID. |
| `capacity` | integer?; admin | Configured nonnegative maximum. |
| `reserved_quantity` | integer; admin | Capacity held by active/unresolved Reservations. |
| `available_quantity` | integer; admin | Currently available capacity. |
| `sales_opens_at` | timestamp?; admin | Scheduled sales opening. |
| `sales_closes_at` | timestamp?; admin | Scheduled sales closing; no later than Event end. |
| `provider_mappings` | ProviderMapping[]; admin | Optional connection-scoped resource associations. |
| `ProviderMapping.connection_id` | string | Payment connection owning the resource. |
| `ProviderMapping.resource_type` | enum | square_item_variation or stripe_price. |
| `ProviderMapping.resource_reference` | string | Non-secret verified provider resource ID. |
| `ProviderMapping.verified_at` | timestamp | When the Site verified the resource. |

Mapping writes are guarded by the Event `expected_version`, increment its version and audit actor, and are scoped to a Site-assigned connection. Order creation copies the active connection's mapping into the accepted purchase snapshot; later replacement or removal leaves older Orders and payment attempts unchanged.

### Quote and accepted pricing

| Field | Type | Meaning |
| --- | --- | --- |
| `quote_id` | string | Quote ID. |
| `event_id` | string | Quoted Event. |
| `quantity` | integer | Requested Ticket count. |
| `unit_price` | Money | Price per Ticket. |
| `subtotal` | Money | Base amount for the quantity. |
| `buyer_fees` | BuyerFee[] | Buyer-facing fees; [] when none. |
| `tax_total` | Money | Buyer-facing tax total. |
| `total` | Money | Subtotal plus buyer fees plus tax. |
| `platform_fee` | Money | Organization-configured platform fee from the pre-tax Ticket subtotal; excluded from buyer total. |
| `platform_fee_basis_points` | integer | Organization rate; 1,000 basis points is the 10% pilot rate. |
| `expires_at` | timestamp | Quote expiry; 10 minutes. |

`Pricing` retains unit_price, subtotal, buyer_fees, tax_total, total, platform_fee, and platform_fee_basis_points from the accepted quote. Organization fee terms are explicitly configured by the HP-OS operator during setup; there is no global default. Processing/platform deductions are reported separately from the buyer total.

### Order

| Field | Type | Meaning |
| --- | --- | --- |
| `order_id` | string | Order ID. |
| `order_reference` | string | Human-readable lookup reference. |
| `quantity` | integer | Ticket count purchased/reserved. |
| `created_at` | timestamp | Order creation instant. |
| `updated_at` | timestamp | Latest Order update. |
| `buyer_name` | string | Purchaser name. |
| `delivery_email` | string | Current delivery address. |
| `pricing` | Pricing | Accepted immutable buyer price breakdown. |
| `checkout_expires_at` | timestamp | Payment-start deadline. |
| `checkout_status` | enum | active, awaiting_payment_result, expired, ended. |
| `event` | PublicEvent | Current Event data. |
| `payment_status` | enum | unpaid, processing, paid, failed, unknown, conflicted. |
| `issuance_status` | enum | not_started, pending, issued, failed, blocked. |
| `delivery_status` | enum | not_sent, pending, sent, delivered, failed. |
| `refund_status` | enum | none, partial, full. |
| `refunds` | Refund[] | Buyer-safe verified refund outcomes and minor-unit amounts; provider references are omitted. |
| `tickets` | PublicTicket[] | Complete issued set, ordinal order; [] until issued. |
| `order_token` | string; creation only | Buyer access token; absent from normal Order reads. |
| `version` | integer; admin | Guarded Order version. |
| `buyer_id` | string; admin | Site Buyer record association. |
| `quote_id` | string; admin | Accepted quote ID. |
| `checkout_identity` | Person; admin | Immutable original checkout name/email. |
| `access_request_id` | string?; admin | Private approval association; null for public. |
| `approved_attendee` | Person?; admin | Vetted private attendee; null for public. |
| `reservation` | Reservation; admin | Capacity claim. |
| `payment_attempts` | PaymentAttempt[]; admin | Provider execution history. |
| `refunds` | Refund[]; admin | Verified refund history. |
| `refund_reports` | RefundReport[]; admin | Verified observations, including stale reports and conflict flags. |
| `fee_records` | FeeRecord[]; admin | Verified component fees/revisions. |
| `notification_jobs` | NotificationJob[]; admin | Related delivery work. |
| `issues` | Issue[]; admin | Problems needing investigation. |

### Ticket

| Field | Type | Meaning |
| --- | --- | --- |
| `ticket_id` | string | Ticket ID. |
| `ticket_token` | string; public | Individual page-access token. |
| `ordinal` | integer | Stable Ticket number within Order, starting at 1. |
| `issued_at` | timestamp | Issuance time. |
| `event` | PublicEvent; public | Current Event details. |
| `qr_payload` | string; public/Wallet | Dedicated admission token; no personal data or page URL. |
| `attendee_name` | string?; public/Wallet | Approved private attendee name; null for public. |
| `admission_status` | enum | unused or admitted. |
| `admitted_at` | timestamp? | Successful Admission time; null before entry. |
| `can_admit` | boolean | Entry eligibility now; rechecked on admission. |
| `admission_blockers` | string[] | already_admitted, event_canceled, ticket_refunded, check_in_not_open, check_in_closed. |
| `event_id` | string; admin | Associated Event. |
| `order_id` | string; admin | Associated Order. |
| `order_reference` | string; admin | Associated human-readable Order reference. |
| `version` | integer; admin | Ticket record version. |
| `created_at` | timestamp; admin | Record creation instant. |
| `updated_at` | timestamp; admin | Latest update instant. |
| `buyer_id` | string; admin | Associated Buyer. |
| `buyer_name` | string; admin | Purchaser name. |
| `delivery_email` | string; admin | Current delivery email. |
| `approved_attendee` | Person?; admin | Private attendee name/email; null for public. |

PublicTicket uses its public/common fields above. AdminTicket uses admin/common fields and omits event, ticket_token, qr_payload, and attendee_name. Admin Order retains its broader, Site-authorized operational view.

### Access Request and approval lookup

| Field | Type | Meaning |
| --- | --- | --- |
| `request_id` | string | Access Request ID inside the record. |
| `event_id` | string; admin | Associated Event. |
| `name` | string; admin/input | Intended attendee name. |
| `email` | string; admin/input | Intended attendee email; not necessarily payer. |
| `status` | enum; admin | pending, approved, rejected. |
| `version` | integer; admin | Guarded request version. |
| `created_at` | timestamp; admin | Submission instant. |
| `updated_at` | timestamp; admin | Latest update instant. |
| `decision_at` | timestamp?; admin | Decision instant; null while pending. |
| `paid_order_id` | string?; admin | Successful purchase ID; null until paid. |
| `event` | PublicEvent; approval lookup | Current Event. |
| `approved_attendee` | Person; approval lookup | Previously vetted attendee. |
| `max_quantity_per_order` | integer; approval lookup | Exactly 1. |
| `purchase_completed` | boolean; approval lookup | Approval has produced a paid purchase. |
| `checkout_in_progress` | boolean; approval lookup | An active/unresolved checkout already exists. |

### Reservation and Admission

| Field | Type | Meaning |
| --- | --- | --- |
| `Reservation.reservation_id` | string | Capacity-claim ID. |
| `Reservation.quantity` | integer | Held Ticket quantity. |
| `Reservation.status` | enum | held, consumed, released. |
| `Reservation.expires_at` | timestamp | Scheduled deadline; not proof capacity has released. |
| `Reservation.awaiting_provider_verification` | boolean | Payment might still complete; retain hold. |
| `Admission.admission_id` | string | Successful entry record ID. |
| `Admission.ticket_id` | string | Admitted Ticket. |
| `Admission.event_id` | string | Entry Event. |
| `Admission.admitted_at` | timestamp | Server-confirmed entry instant. |

### Payment connection and attempt

| Field | Type | Meaning |
| --- | --- | --- |
| `PaymentConfiguration.active_connection` | Connection? | Active connection for new Orders; null if unconfigured. |
| `Connection.connection_id` | string | Connection identity. |
| `Connection.provider` | enum | square or stripe. |
| `Connection.environment` | enum | test or live. |
| `Connection.account_reference` | string | Non-secret provider account reference. |
| `Connection.location_reference` | string? | Non-secret location where applicable. |
| `Connection.account_eligibility_status` | enum | pending_validation, eligible, or ineligible, based on a Site/operator verification record. |
| `Connection.platform_fee_eligibility_status` | enum | pending_validation, eligible, or ineligible; test connections may omit application fees. |
| `Connection.eligibility_validated_at` | timestamp? | Time of the last operator-recorded eligibility check. |
| `Connection.eligibility_evidence_reference` | string? | Non-secret `ref:` evidence alias. |
| `PaymentAttempt.attempt_id` | string | Attempt ID. |
| `PaymentAttempt.order_id` | string | Owning Order. |
| `PaymentAttempt.connection` | Connection | Frozen assigned provider connection. |
| `PaymentAttempt.total` | Money | Authoritative charge amount. |
| `PaymentAttempt.platform_fee` | Money | Expected platform deduction; not actual settlement proof. |
| `PaymentAttempt.provider_mapping` | ProviderMapping? | Mapping snapshot or null. |
| `PaymentAttempt.provider_checkout_reference` | string? | Registered checkout reference. |
| `PaymentAttempt.provider_payment_reference` | string? | Verified provider payment reference, unique per payment connection. |
| `PaymentAttempt.last_outcome` | enum? | not_started, processing, paid, failed, canceled, unknown; initially null. |
| `PaymentAttempt.provider_can_take_payment` | boolean? | true/false/null; null is unresolved. |
| `PaymentAttempt.status` | enum | creating, open, closed, or requires_verification. |
| `PaymentAttempt.version` | integer | Guarded attempt version. |
| `PaymentAttempt.created_at` | timestamp | Creation instant. |
| `PaymentAttempt.updated_at` | timestamp | Latest update instant. |

Payment-attempt list rows also include `requires_report_work`. The list accepts `requires_verification=true|false`, `requires_report_work=true|false`, and `event_id`, together with the signed `cursor` and `limit`. `requires_report_work=true` selects unapplied reports that are still actionable for the Site, including stale non-paid reports retained after a paid or processing observation. Resolved payment-conflict history is excluded. The filter does not change payment state or authorize fulfillment.

Verification list responses also expose Order deadlines and verification-required state; see [provider verification](api.md#checkout-expiry-and-provider-verification). Provider credentials and checkout URLs stay on the Site backend.

Payment-attempt detail responses also include `reports` and `issues`. Reports retain source identity, provider references, observed outcome, applied/conflict state, and timestamps. Issues retain open/resolved state and message; resolved issues include the guarded actor, reason, non-secret verification reference, and prior/new attempt versions. These records are Site-scoped and never include provider credentials or buyer access tokens.

### Provider report fields

| Field | Type | Meaning |
| --- | --- | --- |
| `attempt_id` | string | Recorded payment attempt; may be supplied in the path. |
| `connection_id` | string | Connection used for this payment/refund. |
| `source_reference` | string | Stable identity for a verified provider event/observation; reusing it on another attempt is a conflict. |
| `provider_checkout_reference` | string | Provider checkout identity. |
| `provider_payment_reference` | string? | Provider payment identity; unique to one attempt per connection and required for paid evidence. |
| `provider_refund_reference` | string | Provider refund identity. |
| `outcome` | enum | Payment: processing/paid/failed/canceled/unknown; refund: processing/completed/failed/unknown. |
| `observed_at` | timestamp | Provider observation time. |
| `payment_started_at` | timestamp? | Known payment-start time. |
| `provider_can_take_payment` | boolean? | Whether checkout can still charge; null is unknown. |
| `amount` | integer | Verified minor-unit amount; paid/refund reports require it. |
| `currency` | string | Currency of the reported amount. |
| `provider_checkout_closed` | boolean | Must be true for safe closure/setup-failure reports. |
| `payment_outcome` | enum | not_started, failed, canceled for safe closure. |
| `reason` | string/enum | Setup reason: provider_unavailable or quote_mismatch; resolution/correction uses explanatory text. |
| `verification_reference` | string | Non-secret evidence reference for guarded correction/resolution. |
| `report` | PaymentReportInput | Corrected verified report nested in a resolution action. |
| `report_id` | string; response | Stored report identity. |
| `applied` | boolean; response | Whether this observation affected current state. |
| `attempt` | PaymentAttempt; payment response | Current attempt. |
| `refund` | Refund; refund response | Current refund. |
| `order_id` | string; response | Owning Order. |

Buyer `Refund` objects include only outcome, amount, currency, and observation/creation/update times. Admin `Refund` objects also include the stored refund ID, original attempt/connection, provider payment/refund references, provider/account aliases, and current state. HP-OS does not return provider credentials. `RefundReport` entries retain the source, observation, amount/currency, `applied`, `stale`, and `conflict_code`; raw provider credentials and webhook payloads are not accepted.

### Refund record

| Field | Type | Meaning |
| --- | --- | --- |
| `refund_id` | string | Stored refund identity. |
| `attempt_id` | string | Original payment attempt. |
| `connection_id` | string | Original provider connection. |
| `provider_payment_reference` | string | Refunded provider payment. |
| `provider_refund_reference` | string | Stable provider refund identity. |
| `source_reference` | string | Verified event/observation identity. |
| `outcome` | enum | processing, completed, failed, unknown. |
| `amount` | integer | Refunded minor-unit amount. |
| `currency` | string | Refund currency matching the original payment. |
| `observed_at` | timestamp | Verified provider observation instant. |

The contract also requires refund timestamps/history without enumerating every stored timestamp field name.

Completed refund amounts accumulate per Order and cannot exceed its confirmed payment amount. Full refund blocks future Admission; capacity is returned per unadmitted Ticket once, while already-admitted Tickets keep their Admission record and do not return capacity. A full refund before issuance releases the held Reservation and prevents a later issuance retry. Event cancellation remains a separate Event state.

### Submission, lookup, and Admission input

| Field | Type | Meaning |
| --- | --- | --- |
| `received` | boolean; submission response | true acknowledges the Access Request without returning its approval token. |
| `accepted` | boolean; recovery response | true acknowledges recovery regardless of matching Orders. |
| `order_reference` | string; lookup input | Exact human-readable purchase reference; choose this or email. |
| `email` | string; lookup/recovery input | Current delivery email; lookup chooses this or order_reference. |
| `qr_token` | string; Admission input | Scanned qr_payload, sent unchanged; choose this or ticket_id. |
| `ticket_id` | string; Admission input | Manually selected Ticket; choose this or qr_token. |
| `access_request_token` | string; Order input | Approval token required for private checkout only. |
| `buyer` | BuyerInput; Order input | Purchaser name/email, separate from the approved attendee. |

### Fee component and confirmation

| Field | Type | Meaning |
| --- | --- | --- |
| `actor` | Actor; admin write | Site-asserted user/system attribution for the verified report. |
| `attempt_id` | string | Owning payment attempt. |
| `connection_id` | string | Provider connection. |
| `scope_type` | enum | payment or refund. |
| `scope_reference` | string | Provider payment/refund reference. |
| `source_reference` | string; component | Stable provider fee-component source. |
| `source_revision` | positive safe integer; component | Verified provider revision (including LMNL observation timestamps); newer revisions replace aggregation value. |
| `category` | enum | processing or platform. |
| `direction` | enum; component | charge or return. |
| `amount` | integer; component | Nonnegative actual fee component, not an estimate. |
| `currency` | string; component | Actual settlement currency; no conversion implied. |
| `observed_at` | timestamp | Provider observation time. |
| `fee_record_id` | string; response/record | Fee component record identity. |
| `applied` | boolean; report response | Whether current component value changed. |
| `order_id` | string; response | Owning Order. |
| `totals` | FeeConfirmationTotal[]; confirmation input | Complete verified currency set for the scope/category. |
| `totals[].currency` | string | Unique currency in the confirmation. |
| `totals[].charged` | integer | Verified charged minor units. |
| `totals[].returned` | integer | Verified returned minor units. |
| `reporting_status` | enum; confirmation response | complete when confirmation is accepted. |

`FeeRecord` retains component input fields, ID, and revision history. Explicit zero confirms no fee; absence remains pending.

### Event totals

| Field | Type | Meaning |
| --- | --- | --- |
| `event_id` | string | Event measured. |
| `as_of` | timestamp | Consistent snapshot instant. |
| `sales` | SalesRow[] | Separate rows for each relevant currency. |
| `sales[].gross_paid_sales` | Money | Accepted confirmed payments. |
| `sales[].refunded_amount` | Money | Completed refunds. |
| `sales[].net_sales` | Money | Gross paid sales minus refunds. |
| `sales[].processing_fees` | FeeTotals | Actual provider processing deductions/returns. |
| `sales[].platform_fees` | FeeTotals | Actual LMNL platform deductions/returns. |
| `FeeTotals.reporting_status` | enum | pending or complete. |
| `FeeTotals.charged` | Money? | Confirmed deductions; null while pending. |
| `FeeTotals.returned` | Money? | Confirmed returns/credits; null while pending. |
| `FeeTotals.net` | Money? | Charged minus returned; null while pending. |
| `tickets` | TicketCounts | History/validity/entry counts. |
| `tickets.issued` | integer | All issued Tickets, including later invalidated ones. |
| `tickets.valid` | integer | Not canceled/fully refunded; independent of check-in time; may include admitted Tickets. |
| `tickets.admitted` | integer | Tickets with successful Admission. |

### Notification job and claim

| Field | Type | Meaning |
| --- | --- | --- |
| `job_id` | string | Durable delivery-work identity. |
| `kind` | enum | access_approved, tickets_ready, order_recovery, event_changed, event_canceled, wallet_update. |
| `status` | enum | pending, failed, completed; separate from delivery state. |
| `event_id` | string? | Related Event. |
| `order_id` | string? | Related Order. |
| `access_request_id` | string? | Related Access Request. |
| `ticket_id` | string? | Related Ticket. |
| `is_superseded` | boolean | Obsolete job excluded from claims. |
| `attempt_count` | integer | Dispatch attempt count. |
| `available_at` | timestamp | When eligible for claiming/retry. |
| `created_at` | timestamp | Job creation instant. |
| `updated_at` | timestamp | Latest update instant. |
| `requires_verification` | boolean | Verify prior external send before retrying. |
| `provider_message_reference` | string? | Confirmed provider dispatch/message reference. |
| `failure_class` | enum? | Explicit failed-dispatch classification: `transient` follows the retry schedule; `permanent` stays failed until a guarded action. Omitted failed reports default to `transient`; HP-OS never infers it from `error_code`. |
| `payload` | object | Kind-specific operational delivery content. |
| `claim_id` | string?; claim response | Lease identity; null if no jobs. |
| `lease_expires_at` | timestamp?; claim response | Lease deadline; null if no jobs. |
| `lease_fence` | integer; claimed job/outcome input | Monotonically increasing per-job fence; required when reporting a dispatch outcome. |
| `jobs` | NotificationJob[]; claim response | Claimed work; [] if none. |
| `dispatch_attempts` | object[]; job detail | Latest attempts with claim ID, fence, attempt number, outcome, safe provider reference, observation time, error code, and explicit failure class. |
| `delivery_reports` | object[]; job detail | Latest provider event reference, message reference, outcome, and observation time. |
| `delivery_status` | enum?; job detail | Newest delivery observation; null before a provider report. |
| `outcome` | enum; dispatch input | completed, failed, unknown. |
| `observed_at` | timestamp; report input | Provider observation instant. |
| `error_code` | string?; dispatch input | Provider failure reason when available. It does not determine retryability. |
| `failure_class` | enum?; dispatch input | Optional on `failed` only: `transient` or `permanent`; omitted means `transient`. |
| `provider_event_reference` | string; delivery input | Stable delivery-event identity. |
| `outcome` | enum; delivery input | delivered or failed. |

### Notification payload contents

| Kind | Content |
| --- | --- |
| `access_approved` | `{ attendee: { name, email }, approval_token }`. |
| `tickets_ready` | `{ recipient_email, buyer_name, event: { event_id, event_reference, title, starts_at, ends_at, time_zone, venue: { name, address } }, order: { order_id, order_reference, order_token } }`. |
| `order_recovery` | `{ recipient_email, orders: [{ order_id, order_reference, order_token, expires_at }] }`. |
| `event_changed` | `{ recipient_email, order: { order_id, order_reference }, event: { event_id, event_reference, title, starts_at, ends_at, time_zone, venue: { name, address }, changed_fields: [...] } }`; `changed_fields` lists changed values from `starts_at`, `ends_at`, `time_zone`, `venue.name`, and `venue.address`. |
| `event_canceled` | `{ recipient_email, order: { order_id, order_reference }, event: { event_id, event_reference, title, starts_at, ends_at, time_zone, venue: { name, address } }, canceled_at }`. |
| `wallet_update` | `{ ticket_id, data_version }`. |

All members shown are required. `venue.address` may be `null`; `changed_fields` is nonempty and duplicate-free, and `orders` is nonempty. Nested IDs match the related job IDs, and all timestamps include a UTC offset. Published arrival edits create one durable `event_changed` job per paid Order in the same transaction; older unsent, unattempted, unclaimed jobs for that Event are superseded, and a fan-out failure rolls back the edit and new jobs. Published Event edits that change stable pass-visible content, arrival/check-in details, or price, Event cancellation or archival, successful Admission, and applied full refunds also create one `wallet_update` job per affected issued Ticket in the same transaction; clock-derived `event.sales_status`, email correction, and partial refunds do not. Wallet jobs carry the post-mutation `data_version`, and a queue failure rolls back the triggering mutation. Order and Ticket APIs return the current Event details. Templates, URLs, provider credentials, and Apple device/signing credentials belong to LMNL.

### Wallet data, issues, and audit metadata

| Field | Type | Meaning |
| --- | --- | --- |
| `WalletData.ticket_id` | string | Ticket/pass identity. |
| `WalletData.event` | PublicEvent | Current Event. |
| `WalletData.qr_payload` | string | Stable admission token. |
| `WalletData.attendee_name` | string? | Approved private attendee name. |
| `WalletData.used` | boolean | Successful Admission exists. |
| `WalletData.voided` | boolean | Event canceled or Order fully refunded. |
| `WalletData.data_version` | string | Opaque change token covering stable persisted pass data. Computed `event.sales_status` is excluded because it changes with the clock rather than a persisted pass mutation. |
| `Issue.issue_id` | string | Investigation issue ID. |
| `Issue.code` | string | Problem category. |
| `Issue.status` | enum | open or resolved. |
| `Issue.message` | string | Readable explanation. |
| `Issue.created_at` | timestamp | Issue creation instant. |
| `Issue.resolved_at` | timestamp? | Resolution instant; null while open. |
| `expected_version` | integer; guarded input | Version the client loaded; reject stale changes. |
| `actor` | Actor; admin writes | Site-asserted user/system attribution, not a credential. |

For `tickets_ready` jobs, an Order's current delivery state is derived from the newest applicable job: `pending` while dispatch is pending or requires verification, `sent` after confirmed dispatch without a delivery report, `delivered` after a successful delivery report, and `failed` after a failed dispatch or delivery report. An unknown result never authorizes a blind resend. Delivery-email correction is accepted for a confirmed failed or delivered latest job; pending, sent without delivery, unknown, missing, and superseded latest jobs return a stable `409` state fence. `recovery_actions` records `reason` and `verification_reference` for delivery-email corrections.

Audit history retains actor, operation, timestamp, prior/new versions, and non-secret evidence references. Exact audit-history wire fields are not enumerated in the contract; use its detailed rules rather than assuming a schema.

## Request and response bodies

Each row lists operation-specific body fields/result data. Apply common headers and admin `actor` separately. `expected_version` is required for guarded edits/actions; portfolio Photo creation also requires the current Artwork version, while provider reports, claims, and Admission do not generally use it.



| Operation | JSON input | Result inside data |
| --- | --- | --- |
| List admin Artworks | Optional `publication_status, original_status, collection_id, limit, cursor` | `Paginated AdminArtwork[]; 200` |
| Create Artwork | `title, displayed_artwork_id, optional slug/description/medium/dimensions/created_on/Cardano IDs, actor` | `AdminArtwork; 201; draft, available, empty memberships/photos` |
| Edit Artwork | `Changed Artwork fields, original_status, expected_version, actor` | `AdminArtwork; 200` |
| Artwork action | `expected_version, actor` | `AdminArtwork; 200; publish or archive` |
| Read admin Artwork | No body | `AdminArtwork; 200` |
| List admin Photos | Optional `limit, cursor` | `Paginated AdminPhoto[]; 200` |
| Create Collection | `name, optional description, actor` | `AdminCollection; 201; active and appended` |
| Edit Collection | `Changed name/description/is_active/position, expected_version, actor` | `AdminCollection; 200` |
| Add/remove membership | `expected_version (Collection), expected_artwork_version, actor` | `{collection: AdminCollection, artwork: AdminArtwork}; 200` |
| List admin Collection Artworks | `limit, cursor` | `Paginated CollectionArtwork[]; 200` |
| Reorder Collection Artworks | `artwork_ids (complete unique membership list), expected_version, actor` | `AdminCollection; 200` |
| Reorder Artwork Photos | `photo_ids (complete unique Photo list), expected_version, actor` | `AdminArtwork; 200` |
| Select hero | `photo_id, expected_version, actor` | `AdminArtwork; 200; selected Photo must be ready` |
| Remove Photo | `expected_version (Photo), expected_artwork_version (Artwork), actor, optional replacement_hero_photo_id` | `AdminArtwork; 200; atomically guarded, published Artwork keeps one ready Photo and hero; stale version returns 409` |
| Upload Photo | `multipart: file + metadata {expected_version (Artwork), actor}` | `AcceptedPhoto; 202; processing; returns new Artwork version` |
| Retry Photo | `multipart: file + metadata {expected_version (Photo), actor}` | `AcceptedPhoto; 202; retries failed initial Photo or replacement on same Photo ID` |
| Replace Photo | `multipart: file + metadata {expected_version (Photo), actor}` | `AcceptedPhoto; 202; for a ready Photo with no replacement, old variants remain until both new variants are ready` |
| List public Artworks | Optional `collection_id, limit, cursor` | `Paginated PublicArtwork[]; 200` |
| Read public Artwork | No body | `PublicArtwork; 200` |
| List public Collections | Optional `limit, cursor` | `Paginated PublicCollection[]; 200` |
| Read public Collection | No body | `PublicCollection; 200` |
| List Collection Artworks | Optional `limit, cursor` | `Paginated PublicArtwork[]; 200; membership order` |
| Read public image variant | `variant` path is `grid_400` or `artwork_1600` | `image/webp bytes; 200; Site key required` |
| Create draft | `Event/offering fields; may all be omitted` | `AdminEvent; 201` |
| Edit Event | `Changed Event/offering fields + expected_version` | `AdminEvent; 200` |
| Event action | `expected_version` | `AdminEvent; 200` |
| Set mapping | `actor, resource_type, resource_reference, verified_at, expected_version` | `AdminEvent; 200` |
| Delete mapping | `actor, expected_version` | `AdminEvent; 200` |
| Quote | Public: `quantity` 1–8; private: `quantity` 1 plus `access_request_token` | Quantity-specific Quote; 201 |
| Create Order | Public: `quote_id, buyer {name,email}`; private: `quote_id, access_request_token, buyer {name,email}` | One unpaid Order holding the requested quantity + Reservation + order_token; 201 |
| Submit Access Request | `name, email` | `{received:true}; 201` |
| Edit Access Request | `Changed name/email + expected_version` | `AdminAccessRequest; 200` |
| Request decision | `expected_version` | `AdminAccessRequest; 200` |
| Recover Orders | `email` | `{accepted:true}; 202` |
| Manual lookup | `Exactly one of order_reference/email; optional limit/cursor` | `Paginated OrderSummary[]; 200` |
| Admission | `Exactly one of qr_token/ticket_id` | `Admission; 201` |
| Retry issuance / resend | `expected_version` | `AdminOrder; 202` |
| Correct delivery email | `email, reason, verification_reference, expected_version` | `AdminOrder; 202` |
| Create payment attempt | `No operation fields` | `PaymentAttempt; 201` |
| Register checkout | `connection_id, provider_checkout_reference, provider_can_take_payment:true` | `PaymentAttempt; 200` |
| Payment report | `connection_id, source_reference, provider_checkout_reference, provider_payment_reference, outcome, observed_at, payment_started_at, provider_can_take_payment; amount/currency required for paid` | `{report_id,applied,attempt,order_id}; new 201 / repeat 200` |
| Setup failure | `reason, provider_checkout_closed:true, payment_outcome` | `PaymentAttempt; 200` |
| Closure report | `connection_id, source_reference, provider_checkout_reference, observed_at, provider_checkout_closed:true, payment_outcome` | `PaymentAttempt; 200` |
| Resolve attempt | `expected_version, reason, verification_reference, report` | `200; guarded verified resolution` |
| Refund report | `attempt_id, connection_id, provider_payment_reference, provider_refund_reference, source_reference, outcome, amount, currency, observed_at` | `{report_id,applied,stale,refund,order_id,report}; new 201 / exact replay 200 / conflict 409 / payment_not_confirmed 503 with retry` |
| Fee report | `actor, attempt_id, connection_id, scope_type, scope_reference, source_reference, source_revision, category, direction, amount, currency, observed_at` | `{fee_record_id,applied,order_id}; new/revised 201 / repeat 200 / scope conflict 409` |
| Fee confirmation | `actor, attempt_id, connection_id, scope_type, scope_reference, category, totals, observed_at` | `{order_id,scope_type,scope_reference,category,reporting_status}; 200 / scope conflict 409` |
| Claim jobs | `Optional limit, kinds` | `{claim_id,lease_expires_at,jobs}; 200` |
| Renew claim | `No operation fields` | `{claim_id,lease_expires_at}; 200` |
| Dispatch outcome | `claim_id, outcome, provider_message_reference, observed_at, error_code, failure_class` | `NotificationJob; 200` |
| Delivery outcome | `outcome, provider_message_reference, provider_event_reference, observed_at` | `NotificationJob; 200` |

Refund-scoped fee reports and confirmations require a completed refund whose Order and payment attempt are still confirmed paid; otherwise HP-OS returns `409 fee_report_conflict`.

`OrderSummary` contains order_id, order_reference, buyer_name, delivery_email, the four Order status fields, and tickets using AdminTicket. It omits buyer access tokens. Normal GET requests have no JSON body; list filters go in the query string. Manual lookup puts its pagination in its POST body.
