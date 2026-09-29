// The documented route catalogue mirrors the endpoint tables in docs/api/api-ref.md.
// Every business route stays unavailable here until its implementation lands.
export type ExplorerFieldKind = "path" | "query" | "body";

export interface ExplorerField {
  id: string;
  label: string;
  kind: ExplorerFieldKind;
  description: string;
  details: string;
  example?: string;
  protected?: boolean;
  aliases?: string[];
}

export interface ExplorerEndpoint {
  id: string;
  domain: string;
  title: string;
  method: string;
  path: string;
  description: string;
  availability: "available" | "unavailable";
  fields: ExplorerField[];
}

function labelForId(id: string): string {
  return id
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace("Id", "ID")
    .replace("Qr", "QR");
}

function field(id: string, kind: ExplorerFieldKind, description: string, details: string, example?: string, protectedValue = false): ExplorerField {
  const inferredProtected = protectedValue || /token|email|name|password|secret|authorization|api[_-]?key|qr[_-]?payload/i.test(id);
  return { id, label: labelForId(id), kind, description, details, example, protected: inferredProtected };
}

function endpoint(
  id: string,
  domain: string,
  title: string,
  method: string,
  path: string,
  description: string,
  bodyFields: Array<[string, string, string, string?, boolean?]> = [],
  queryFields: Array<[string, string, string, string?]> = [],
): ExplorerEndpoint {
  const pathFields = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => {
    const name = match[1];
    const protectedValue = name.endsWith("token");
    return field(
      name,
      "path",
      protectedValue ? "A purpose-specific access value used in this URL." : `The ${labelForId(name)} that identifies the record in this path.`,
      protectedValue ? "Access tokens are purpose-specific and should stay masked and source-labeled." : `The API uses this value to choose the ${labelForId(name)} within the authenticated Site.`,
      protectedValue ? "Paste a token or choose a current-session value" : `example-${name}`,
      protectedValue,
    );
  });
  const query = queryFields.map(([name, description, details, example]) => field(name, "query", description, details, example));
  const body = bodyFields.map(([name, description, details, example, protectedValue]) => field(name, "body", description, details, example, protectedValue));
  const fields = [...pathFields, ...query, ...body];
  return { id, domain, title, method, path, description, availability: "unavailable", fields };
}

const listFields: Array<[string, string, string, string?]> = [
  ["limit", "The number of records to return, from 1 to 100.", "List size defaults to 50 and cannot exceed 100.", "50"],
  ["cursor", "The position for the next page.", "Cursors are opaque and must be reused with the original filters.", "next-page-cursor"],
];

export const explorerEndpoints: ExplorerEndpoint[] = [
  endpoint("public-events-list", "Public Events", "List published Events", "GET", "/v1/public/events", "Read published current or past Events.", [], [["period", "Choose current or past Events.", "The public Events period defaults to current.", "current"], ...listFields]),
  endpoint("public-event-read", "Public Events", "Read a published Event", "GET", "/v1/public/events/{event_id}", "Read one published Event and its Ticket offering."),
  endpoint("public-event-quote", "Public Events", "Quote Ticket quantity", "POST", "/v1/public/events/{event_id}/quotes", "Calculate an accepted price without holding capacity.", [["quantity", "The number of Tickets to quote.", "Public Orders allow 1 to 8 Tickets.", "1"]]),
  endpoint("public-order-create", "Public Orders", "Create an unpaid Order", "POST", "/v1/public/orders", "Create an Order and Reservation from an accepted quote.", [["quote_id", "The accepted Quote to use.", "A Quote can create one Order only.", "quote-id"], ["buyer.name", "The purchaser name.", "Buyer identity is separate from an approved private attendee.", "Your name"], ["buyer.email", "The purchaser email.", "The delivery email is normalized by the API.", "buyer@example.com", true], ["access_request_token", "Optional approved private-checkout access.", "Private checkout access is a purpose-specific token.", "Paste a token or choose a current-session value", true]]),
  endpoint("public-order-read", "Public Orders", "Read a purchase", "GET", "/v1/public/orders/{order_token}", "Read one buyer Order and its issued Tickets through an access token."),
  endpoint("public-ticket-read", "Public Tickets", "Read one Ticket", "GET", "/v1/public/tickets/{ticket_token}", "Read one independently shareable Ticket page through its access token."),
  endpoint("public-access-request-create", "Access Requests", "Submit an Access Request", "POST", "/v1/public/events/{event_id}/access-requests", "Submit intended attendee details for private checkout approval.", [["name", "The intended attendee name.", "This identifies the attendee, not necessarily the purchaser.", "Attendee name"], ["email", "The intended attendee email.", "Approval access is sent to this address.", "attendee@example.com", true]]),
  endpoint("public-access-request-read", "Access Requests", "Read approved checkout access", "GET", "/v1/public/access-requests/{access_request_token}", "Read approved attendee and checkout eligibility through an access token."),
  endpoint("public-order-recovery", "Public Orders", "Request Order recovery", "POST", "/v1/public/order-recovery", "Queue temporary Order links with a generic acknowledgement.", [["email", "The current delivery email.", "Recovery responses do not disclose whether an Order exists.", "buyer@example.com", true]]),
  endpoint("public-wallet-data", "Public Tickets", "Read buyer Wallet data", "GET", "/v1/public/tickets/{ticket_token}/apple-wallet-data", "Read unsigned data that a Site backend can use to create an Apple Wallet pass."),

  endpoint("admin-events-list", "Admin Events", "List all Events", "GET", "/v1/admin/events", "Read draft and published Event configuration for the authenticated Site.", [], [["publication_status", "Filter by draft or published.", "Admin Event lists can filter by publication status.", "published"], ["visibility", "Filter by public or private.", "Visibility controls the checkout path.", "public"], ["is_archived", "Filter archived Events.", "Archived Events remain in operational history.", "false"], ["is_canceled", "Filter canceled Events.", "Cancellation stops sales and Admission.", "false"], ...listFields]),
  endpoint("admin-event-read", "Admin Events", "Read Event configuration", "GET", "/v1/admin/events/{event_id}", "Read one Event's configuration and operational state."),
  endpoint("admin-event-create", "Admin Events", "Create a draft Event", "POST", "/v1/admin/events", "Create an incomplete draft Event for later editing."),
  endpoint("admin-event-edit", "Admin Events", "Edit an Event", "PATCH", "/v1/admin/events/{event_id}", "Edit supplied Event or Ticket offering fields with a version guard.", [["expected_version", "The version last read by the caller.", "Guarded edits reject stale versions.", "1"]]),
  endpoint("admin-event-action", "Admin Events", "Run an Event action", "POST", "/v1/admin/events/{event_id}/actions/{action}", "Publish, stop sales, resume sales, cancel, or archive an Event.", [["expected_version", "The version last read by the caller.", "Guarded actions reject stale versions.", "1"]]),
  endpoint("admin-event-mapping-set", "Admin Events", "Set a provider mapping", "PUT", "/v1/admin/events/{event_id}/provider-mappings/{connection_id}", "Register a verified provider resource for future checkout.", [["resource_type", "The provider resource type.", "The contract supports Square item variations and Stripe Prices.", "stripe_price"], ["resource_reference", "The provider resource reference.", "This is metadata, not a provider credential.", "price_reference"], ["verified_at", "The time the Site verified the resource.", "Verification does not prove live fee settlement.", "2026-10-11T02:00:00Z"], ["expected_version", "The version last read by the caller.", "Guarded mapping changes reject stale versions.", "1"]]),
  endpoint("admin-event-mapping-delete", "Admin Events", "Remove a provider mapping", "DELETE", "/v1/admin/events/{event_id}/provider-mappings/{connection_id}", "Remove a provider mapping for future Orders.", [["expected_version", "The version last read by the caller.", "Guarded mapping changes reject stale versions.", "1"]]),

  endpoint("admin-event-orders", "Admin Orders and Admission", "List Event Orders", "GET", "/v1/admin/events/{event_id}/orders", "Read operational Orders for one Event.", [], [["payment_status", "Filter Orders by payment status.", "Use the contract's payment status enum.", "paid"], ["issuance_status", "Filter by Ticket issuance status.", "Use the contract's issuance status enum.", "issued"], ["delivery_status", "Filter by delivery status.", "Use the contract's delivery status enum.", "sent"], ["refund_status", "Filter by refund coverage.", "Use the contract's refund status enum.", "none"], ...listFields]),
  endpoint("admin-order-read", "Admin Orders and Admission", "Read an Order", "GET", "/v1/admin/orders/{order_id}", "Read one operational Order."),
  endpoint("admin-event-tickets", "Admin Orders and Admission", "List Event Tickets", "GET", "/v1/admin/events/{event_id}/tickets", "Read Event Tickets without buyer page tokens or QR payloads.", [], [["admission_status", "Filter by unused or admitted.", "Admission state is current operational state.", "unused"], ["can_admit", "Filter by current entry eligibility.", "Eligibility is checked again when Admission is requested.", "true"], ...listFields]),
  endpoint("admin-event-totals", "Admin Orders and Admission", "Read Event totals", "GET", "/v1/admin/events/{event_id}/totals", "Read consistent money, fee, and Ticket totals."),
  endpoint("admin-ticket-lookup", "Admin Orders and Admission", "Look up Orders", "POST", "/v1/admin/events/{event_id}/ticket-lookup", "Find Orders by reference or current delivery email.", [["order_reference", "The human-readable Order reference.", "Use exactly one of Order reference or email.", "ORD-0001"], ["email", "The current delivery email.", "Use exactly one of email or Order reference.", "buyer@example.com", true], ["limit", "The number of matching Orders to return.", "Lookup accepts the same 1 to 100 limit as lists.", "50"], ["cursor", "The position for the next page.", "Reuse the cursor with the original lookup filter.", "next-page-cursor"]]),
  endpoint("admin-admission", "Admin Orders and Admission", "Record one Admission", "POST", "/v1/admin/events/{event_id}/admissions", "Record one entry by QR token or selected Ticket ID.", [["qr_token", "The scanned Admission QR value.", "The QR token is separate from the Ticket page token.", "Paste a token or choose a current-session value", true], ["ticket_id", "The manually selected Ticket ID.", "Use exactly one of QR token or Ticket ID.", "ticket-id"]]),
  endpoint("admin-order-action", "Admin Orders and Admission", "Run an Order action", "POST", "/v1/admin/orders/{order_id}/actions/{action}", "Retry issuance, resend a Ticket email, or correct its delivery email.", [["expected_version", "The version last read by the caller.", "Guarded actions reject stale versions.", "1"], ["email", "The replacement delivery email when correcting delivery.", "A corrected email replaces buyer page links after verification.", "buyer@example.com", true], ["reason", "The reason for the correction.", "The reason is part of the correction evidence.", "Buyer requested correction"]]),
  endpoint("admin-ticket-wallet-data", "Admin Orders and Admission", "Read admin Wallet data", "GET", "/v1/admin/tickets/{ticket_id}/apple-wallet-data", "Read unsigned data for Site-owned Wallet update work."),

  endpoint("admin-event-access-requests", "Admin Access Requests", "List Access Requests", "GET", "/v1/admin/events/{event_id}/access-requests", "Read attendee requests for one Event.", [], [["email", "Filter by attendee email.", "Email matching is normalized by the contract.", "attendee@example.com",], ["status", "Filter pending, approved, or rejected requests.", "Status is resource-specific.", "pending"], ...listFields]),
  endpoint("admin-access-request-read", "Admin Access Requests", "Read an Access Request", "GET", "/v1/admin/access-requests/{request_id}", "Read one attendee request."),
  endpoint("admin-access-request-edit", "Admin Access Requests", "Edit an Access Request", "PATCH", "/v1/admin/access-requests/{request_id}", "Correct pending attendee details with a version guard.", [["name", "The corrected attendee name.", "The attendee is separate from the purchaser.", "Attendee name"], ["email", "The corrected attendee email.", "Approval access is sent to this address.", "attendee@example.com", true], ["expected_version", "The version last read by the caller.", "Guarded edits reject stale versions.", "1"]]),
  endpoint("admin-access-request-action", "Admin Access Requests", "Decide an Access Request", "POST", "/v1/admin/access-requests/{request_id}/actions/{action}", "Approve, reject, or undo an Access Request decision.", [["expected_version", "The version last read by the caller.", "Guarded decisions reject stale versions.", "1"]]),

  endpoint("admin-payment-configuration", "Payments and Fees", "Read payment configuration", "GET", "/v1/admin/payment-configuration", "Read the active payment connection for new Orders."),
  endpoint("admin-payment-connection", "Payments and Fees", "Read payment connection", "GET", "/v1/admin/payment-connections/{connection_id}", "Read assigned or historical non-secret connection metadata."),
  endpoint("admin-payment-attempts", "Payments and Fees", "List payment attempts", "GET", "/v1/admin/payment-attempts", "Read payment attempts, including those requiring verification.", [], [["event_id", "Restrict attempts to one Event.", "This filter is Site-scoped.", "event-id"], ["requires_verification", "Show attempts requiring verification.", "Verification state identifies unresolved provider evidence.", "true"], ...listFields]),
  endpoint("admin-payment-attempt-create", "Payments and Fees", "Create a payment attempt", "POST", "/v1/admin/orders/{order_id}/payment-attempts", "Record an attempt before the Site calls its provider."),
  endpoint("admin-checkout-reference", "Payments and Fees", "Register checkout", "POST", "/v1/admin/payment-attempts/{attempt_id}/checkout-reference", "Register a provider checkout before the buyer opens it.", [["connection_id", "The payment connection used.", "Connection assignment is part of the operational record.", "connection-id"], ["provider_checkout_reference", "The provider checkout reference.", "This is a provider reference, not a credential.", "checkout-reference"], ["provider_can_take_payment", "Whether the provider checkout can take payment.", "The contract requires true for a usable checkout.", "true"]]),
  endpoint("admin-payment-report", "Payments and Fees", "Report payment outcome", "POST", "/v1/admin/payment-attempts/{attempt_id}/payment-reports", "Report a Site-verified payment outcome.", [["connection_id", "The payment connection used.", "The connection must match the attempt.", "connection-id"], ["source_reference", "The Site or provider evidence reference.", "Keep provider evidence references non-secret.", "source-reference"], ["provider_checkout_reference", "The checkout reference.", "The reference must match the attempt.", "checkout-reference"], ["provider_payment_reference", "The provider payment reference.", "Use a non-secret provider reference.", "payment-reference"], ["outcome", "The verified payment outcome.", "Paid, failed, or unknown outcomes follow the contract enum.", "paid"], ["amount", "The verified minor-unit amount.", "Required for a paid report.", "1000"], ["currency", "The reported currency.", "Use an uppercase currency code.", "USD"]]),
  endpoint("admin-setup-failure", "Payments and Fees", "Report checkout setup failure", "POST", "/v1/admin/payment-attempts/{attempt_id}/setup-failure", "Report verified setup failure and safe closure.", [["reason", "Why setup failed.", "This records the Site's verified explanation.", "Provider setup unavailable"], ["provider_checkout_closed", "Whether the provider checkout is closed.", "Safe closure requires true.", "true"], ["payment_outcome", "The verified payment outcome.", "Use the contract's payment outcome enum.", "unknown"]]),
  endpoint("admin-closure-report", "Payments and Fees", "Report checkout closure", "POST", "/v1/admin/payment-attempts/{attempt_id}/closure-reports", "Confirm a provider checkout cannot take payment.", [["connection_id", "The payment connection used.", "The connection must match the attempt.", "connection-id"], ["source_reference", "The Site or provider evidence reference.", "Keep provider evidence references non-secret.", "source-reference"], ["provider_checkout_reference", "The checkout reference.", "The reference must match the attempt.", "checkout-reference"], ["observed_at", "When the Site observed closure.", "Use an RFC 3339 timestamp.", "2026-10-11T02:00:00Z"], ["provider_checkout_closed", "Whether the provider checkout is closed.", "Safe closure requires true.", "true"], ["payment_outcome", "The verified payment outcome.", "Use the contract's payment outcome enum.", "unknown"]]),
  endpoint("admin-payment-resolve", "Payments and Fees", "Resolve payment evidence", "POST", "/v1/admin/payment-attempts/{attempt_id}/actions/resolve", "Apply corrected verified evidence with a guarded resolution.", [["expected_version", "The version last read by the caller.", "Guarded resolution rejects stale attempts.", "1"], ["reason", "Why the evidence is being resolved.", "Keep the operational reason visible.", "Verified provider report"], ["verification_reference", "The evidence reference used for verification.", "Use a non-secret reference.", "verification-reference"], ["report", "The corrected payment report.", "The report uses the payment report schema.", "{\"outcome\":\"paid\"}"]]),
  endpoint("admin-refund-report", "Payments and Fees", "Report a refund", "POST", "/v1/admin/orders/{order_id}/refund-reports", "Report a provider refund; this does not initiate one.", [["attempt_id", "The payment attempt being refunded.", "The attempt belongs to the Order.", "attempt-id"], ["connection_id", "The payment connection used.", "The connection must match the original payment.", "connection-id"], ["provider_payment_reference", "The provider payment reference.", "Use a non-secret provider reference.", "payment-reference"], ["provider_refund_reference", "The provider refund reference.", "Use a non-secret provider reference.", "refund-reference"], ["source_reference", "The provider evidence reference.", "Keep evidence references non-secret.", "source-reference"], ["outcome", "The verified refund outcome.", "Use the contract's refund outcome enum.", "refunded"], ["amount", "The refunded minor-unit amount.", "Refund amount is reported in minor units.", "1000"], ["currency", "The refund currency.", "It must match the original payment currency.", "USD"]]),
  endpoint("admin-fee-report", "Payments and Fees", "Report fee components", "POST", "/v1/admin/orders/{order_id}/fee-reports", "Report actual processing or platform fee components.", [["attempt_id", "The payment attempt associated with the fee.", "The attempt belongs to the Order.", "attempt-id"], ["connection_id", "The payment connection used.", "The connection must match the payment.", "connection-id"], ["scope_type", "The scope of the fee.", "Use the contract's fee scope enum.", "payment"], ["scope_reference", "The fee scope reference.", "This identifies the reported scope.", "scope-reference"], ["source_reference", "The provider evidence reference.", "Keep evidence references non-secret.", "source-reference"], ["source_revision", "The provider report revision.", "Revisions support corrected fee reports.", "1"], ["category", "The fee category.", "Use the contract's fee category enum.", "processing"], ["direction", "The fee direction.", "Use the contract's fee direction enum.", "charged"], ["amount", "The actual fee amount in minor units.", "This is a settled component, not an estimate.", "100"], ["currency", "The settlement currency.", "No currency conversion is implied.", "USD"]]),
  endpoint("admin-fee-confirmation", "Payments and Fees", "Confirm fee totals", "POST", "/v1/admin/orders/{order_id}/fee-confirmations", "Confirm complete fee amounts, including a verified zero.", [["attempt_id", "The payment attempt associated with the fee.", "The attempt belongs to the Order.", "attempt-id"], ["connection_id", "The payment connection used.", "The connection must match the payment.", "connection-id"], ["scope_type", "The scope of the fee.", "Use the contract's fee scope enum.", "payment"], ["scope_reference", "The fee scope reference.", "This identifies the confirmed scope.", "scope-reference"], ["category", "The fee category.", "Use the contract's fee category enum.", "processing"], ["totals", "The complete fee totals.", "Totals can include a verified zero.", "{\"amount\":0,\"currency\":\"USD\"}"]]),

  endpoint("admin-notification-jobs", "Notifications", "List notification jobs", "GET", "/v1/admin/notification-jobs", "Read durable notification work.", [], [["event_id", "Restrict jobs to one Event.", "This filter is Site-scoped.", "event-id"], ["order_id", "Restrict jobs to one Order.", "This filter is Site-scoped.", "order-id"], ["status", "Filter by job status.", "Use pending, failed, or completed.", "pending"], ["kind", "Filter by one notification kind.", "The kind identifies the durable work type.", "ticket_email"], ["requires_verification", "Show jobs needing verification.", "Use this when dispatch evidence is unresolved.", "true"], ...listFields]),
  endpoint("admin-notification-job-read", "Notifications", "Read a notification job", "GET", "/v1/admin/notification-jobs/{job_id}", "Read or recheck one durable notification job."),
  endpoint("admin-notification-claims", "Notifications", "Claim notification jobs", "POST", "/v1/admin/notification-jobs/claims", "Claim available jobs for a five-minute lease.", [["limit", "The number of jobs to claim.", "Claims allow 1 to 100 jobs.", "50"], ["kinds", "Optional notification kinds to claim.", "Limit claims to known kinds.", "[\"ticket_email\"]"]]),
  endpoint("admin-notification-claim-renew", "Notifications", "Renew a notification claim", "POST", "/v1/admin/notification-jobs/claims/{claim_id}/renew", "Extend the active five-minute claim lease."),
  endpoint("admin-notification-outcome", "Notifications", "Report dispatch outcome", "POST", "/v1/admin/notification-jobs/{job_id}/outcome-reports", "Report dispatch completed, failed, or unknown.", [["claim_id", "The active claim that owns the job.", "The claim must be valid and unexpired.", "claim-id"], ["outcome", "The dispatch outcome.", "Use completed, failed, or unknown.", "completed"], ["provider_message_reference", "The provider message reference.", "Use a non-secret provider reference.", "message-reference"], ["observed_at", "When the Site observed the outcome.", "Use an RFC 3339 timestamp.", "2026-10-11T02:00:00Z"], ["error_code", "The provider or Site error code.", "Include this when dispatch failed.", "provider_unavailable"]]),
  endpoint("admin-notification-delivery", "Notifications", "Report delivery outcome", "POST", "/v1/admin/notification-jobs/{job_id}/delivery-reports", "Report provider-confirmed email delivery or failure.", [["outcome", "The delivery outcome.", "Use delivered or failed according to the contract.", "delivered"], ["provider_message_reference", "The provider message reference.", "Use a non-secret provider reference.", "message-reference"], ["provider_event_reference", "The provider event reference.", "Use a non-secret provider reference.", "event-reference"], ["observed_at", "When the Site observed delivery.", "Use an RFC 3339 timestamp.", "2026-10-11T02:00:00Z"]]),
];

export const explorerDomains = [...new Set(explorerEndpoints.map((endpoint) => endpoint.domain))];

export const customEndpoint: ExplorerEndpoint = {
  id: "custom-request",
  domain: "Manual request",
  title: "Custom /v1 request",
  method: "GET",
  path: "",
  description: "Prepare a request to any local /v1 path. This mode remains available while documented business endpoints are not implemented.",
  availability: "available",
  fields: [],
};
