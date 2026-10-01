import { readFileSync } from 'node:fs';

export const groups = [
  { title: 'Foundation and Site configuration', from: 23, to: 25 },
  { title: 'Public single-ticket journey', from: 26, to: 33 },
  { title: 'Recovery, operations, refunds, and totals', from: 34, to: 45 },
  { title: 'Private approval and Wallet', from: 46, to: 49 },
  { title: 'Public group purchase', from: 50, to: 50 },
  { title: 'Release verification', from: 51, to: 55 },
];
export const tickets = JSON.parse(readFileSync(new URL('./tickets.json', import.meta.url)));

// Explicit mapping: route availability reflects inspected implementation, not issue closure.
// Generic action paths additionally list which actions currently exist.
const mapping = [
  ['GET /v1/public/events', [26, 27, 33, 41], true],
  ['GET /v1/public/events/{event_id}', [26, 27, 33, 40, 41], true],
  ['GET /v1/public/orders/{order_token}', [28, 30, 31, 33, 38, 39, 41, 42, 47, 50], true],
  ['GET /v1/public/tickets/{ticket_token}', [30, 31, 32, 33, 39, 41, 42, 47, 50], true],
  ['GET /v1/public/access-requests/{access_request_token}', [47], false],
  ['GET /v1/public/tickets/{ticket_token}/apple-wallet-data', [48, 49], false],
  ['POST /v1/public/events/{event_id}/quotes', [28, 33, 47, 50], true, 'Public quantity 1 only; private/group unavailable.'],
  ['POST /v1/public/orders', [28, 33, 47, 50], true, 'Public single-ticket only.'],
  ['POST /v1/public/events/{event_id}/access-requests', [46], false],
  ['POST /v1/public/order-recovery', [38], false],
  ['GET /v1/admin/events', [26, 41], true],
  ['GET /v1/admin/events/{event_id}', [26, 27, 40, 41], true],
  ['POST /v1/admin/events', [26, 46], true, 'Private approval remains unavailable.'],
  ['PATCH /v1/admin/events/{event_id}', [26, 27, 40, 46], true, 'Arrival-change notifications are later work.'],
  ['POST /v1/admin/events/{event_id}/actions/{action}', [26, 27, 41], true, 'publish, archive, stop_sales, resume_sales available; cancel unavailable.'],
  ['PUT /v1/admin/events/{event_id}/provider-mappings/{connection_id}', [29, 44], false],
  ['DELETE /v1/admin/events/{event_id}/provider-mappings/{connection_id}', [29, 44], false],
  ['GET /v1/admin/events/{event_id}/orders', [35, 36, 37, 39, 41, 43], false],
  ['GET /v1/admin/orders/{order_id}', [35, 36, 37, 39, 42, 43, 44], false],
  ['GET /v1/admin/orders/{order_id}/payment-status', [29, 30, 33, 34, 35, 36, 42], true],
  ['GET /v1/admin/events/{event_id}/tickets', [32, 43, 50], false],
  ['GET /v1/admin/events/{event_id}/totals', [42, 43, 45], false],
  ['POST /v1/admin/events/{event_id}/ticket-lookup', [32, 39, 50, 51], true],
  ['POST /v1/admin/events/{event_id}/admissions', [32, 33, 41, 42, 47, 50, 51, 53, 54], true],
  ['POST /v1/admin/orders/{order_id}/actions/{action}', [36, 37, 39], false, 'retry_ticket_issuance, resend_ticket_email, correct_delivery_email unavailable.'],
  ['GET /v1/admin/tickets/{ticket_id}/apple-wallet-data', [48, 49], false],
  ['GET /v1/admin/events/{event_id}/access-requests', [46], false],
  ['GET /v1/admin/access-requests/{request_id}', [46], false],
  ['PATCH /v1/admin/access-requests/{request_id}', [46], false],
  ['POST /v1/admin/access-requests/{request_id}/actions/{action}', [46, 47], false],
  ['GET /v1/admin/payment-configuration', [24, 29, 44], true],
  ['GET /v1/admin/payment-connections/{connection_id}', [24, 29, 34, 44], true],
  ['GET /v1/admin/payment-attempts/{attempt_id}', [29, 30, 34, 35, 44], true],
  ['GET /v1/admin/payment-attempts', [34, 35, 45], false],
  ['POST /v1/admin/orders/{order_id}/payment-attempts', [29, 33, 34, 44, 47, 50], true],
  ['POST /v1/admin/payment-attempts/{attempt_id}/checkout-reference', [29, 33, 34, 44], true],
  ['POST /v1/admin/payment-attempts/{attempt_id}/payment-reports', [30, 33, 34, 35, 41, 44, 47, 50], true],
  ['POST /v1/admin/payment-attempts/{attempt_id}/setup-failure', [29, 34], true],
  ['POST /v1/admin/payment-attempts/{attempt_id}/closure-reports', [29, 34, 41, 44], true],
  ['POST /v1/admin/payment-attempts/{attempt_id}/actions/resolve', [35], false],
  ['POST /v1/admin/orders/{order_id}/refund-reports', [42, 44, 45, 54], false],
  ['POST /v1/admin/orders/{order_id}/fee-reports', [43, 45, 54], false],
  ['POST /v1/admin/orders/{order_id}/fee-confirmations', [43, 45, 54], false],
  ['GET /v1/admin/notification-jobs', [25, 31, 37, 38, 39, 40, 41, 45, 46, 49], true],
  ['GET /v1/admin/notification-jobs/{job_id}', [25, 31, 37, 45, 49], true],
  ['POST /v1/admin/notification-jobs/claims', [25, 31, 37, 38, 40, 41, 45, 46, 49], true],
  ['POST /v1/admin/notification-jobs/claims/{claim_id}/renew', [25, 31, 37, 45, 49], true],
  ['POST /v1/admin/notification-jobs/{job_id}/outcome-reports', [25, 31, 37, 38, 40, 41, 45, 46, 49], true],
  ['POST /v1/admin/notification-jobs/{job_id}/delivery-reports', [25, 31, 37, 38, 40, 41, 45, 46], true],
];
export const routes = mapping.map(([route, ticketNumbers, implemented, note]) => ({
  route, tickets: ticketNumbers, implemented,
  note: note ?? (implemented ? 'Implemented HTTP route; workflow/environment prerequisites still apply.' : 'Documented contract; no handler in this revision.'),
}));

const local = (id, ticket, title, steps, extra = {}) => ({ id, ticket, title, steps, profiles: ['simulation'], ...extra });
export const workflows = [
  local('service', 23, 'Read the local service through its API', ['Read Site configuration and record the HTTP response.'], { scope: 'HTTP service observation. Database migration, privacy, and restart persistence require separate operator evidence.' }),
  local('configuration', 24, 'Site configuration, authentication, and isolation', ['Read the test connection assigned to both Sites.', 'Reject a missing key.', 'Create a synthetic paid Order and Ticket, then reject cross-Site IDs, related records, access tokens and shared-provider reference reuse.'], { otherSite: true }),
  local('durable-jobs', 25, 'Claim, renew, overlap, and process notification work', ['Create a paid single-ticket fixture through HTTP.', 'Inspect and claim its Ticket-email job.', 'Renew the lease and verify an overlapping worker cannot claim it.', 'Report deterministic dispatch and delivery.', 'Invoke the existing bounded HP-OS scheduler.'], { scope: 'Lease/API rehearsal. Process restart and five-minute lease expiry require timed follow-up evidence.' }),
  local('events', 26, 'Staff draft, publish, discover, and archive', ['Create and replay an incomplete draft.', 'Keep draft out of public reads.', 'Save and publish complete details.', 'Read staff and public lists.', 'Archive a separately created ended Event and preserve its direct public page.']),
  local('sales', 27, 'Staff sales controls and Reservation capacity', ['Publish a configured local Event.', 'Stop and resume sales with versions.', 'Reserve one Ticket.', 'Reject capacity below the committed floor.', 'Preserve the accepted Order price after an Event edit.']),
  local('reservation', 28, 'Buyer quote and replay-safe unpaid Order', ['Quote one Ticket without reserving capacity.', 'Create and replay an unpaid Order.', 'Reject used quotes and conflicting key reuse.', 'Race two Orders for one remaining Ticket.']),
  local('checkout', 29, 'Site checkout, closure, and safe replacement', ['Create the HP-OS attempt before the simulated provider.', 'Reject a concurrent unresolved attempt.', 'Register the simulated checkout reference.', 'Report verified simulated closure.', 'Replace within the original window.', 'Reject unsafe setup failure and accept verified closure.'], { scope: 'Catalogless simulation. Provider mappings and real account eligibility remain separate checks.' }),
  local('payment', 30, 'Verified simulated payment and independent Ticket access', ['Read confirmation-pending Order with no Tickets.', 'Report synthetic verified payment.', 'Invoke bounded issuance recovery if needed.', 'Verify exactly one Ticket and separate page/QR tokens.', 'Replay payment without duplicate Tickets.'], { scope: 'Synthetic payment evidence. Deliberately interrupted issuance cannot be injected through the current public API.' }),
  local('delivery', 31, 'Site delivery and buyer pages', ['Create one paid Ticket.', 'Claim the initial email job and verify dispatch separately from delivery.', 'Render Fake LMNL Order/Ticket links.', 'Read independent Order and Ticket pages.']),
  local('admission', 32, 'Staff lookup, simultaneous scans, and safe replay', ['Look up by reference and email without access tokens.', 'Reject invalid and wrong-Event QR submissions.', 'Submit two concurrent scans; exactly one may succeed.', 'Replay the successful scan with its original key.', 'Reject a new scan and manual entry for the admitted Ticket.'], { scope: 'HTTP concurrency rehearsal. Camera, physical-device, role permissions, canceled/refunded, and offline-device checks remain separate.' }),
  local('journey', 33, 'Connected public single-ticket rehearsal', ['Create and publish an Event, quote one Ticket, and reserve it in an unpaid Order.', 'Register a provider checkout whose total matches the accepted Order before payment.', 'Show the Order with no Ticket before payment confirmation.', 'Verify payment, issue exactly one Ticket, and preserve that identity on a repeated payment report.', 'Dispatch the initial email and record delivery separately from the dispatch response.', 'Open the Order page and individual Ticket QR page, then admit once and reject repeat entry.'], { profiles: ['simulation', 'sandbox'], scope: 'Simulation records synthetic provider and email evidence. Sandbox requires explicit Square checkout completion, verified payment and actual Resend delivery. Both profiles are local rehearsal evidence; neither establishes LMNL device or release proof.' }),
  local('closure', 34, 'Closure and replacement rehearsal', ['Keep an unresolved attempt exclusive.', 'Report simulated provider closure.', 'Create one replacement without extending the Order deadline.'], { scope: 'Subset only. Verification frontier, expired/interrupted checkout and unattended provider recovery are unavailable.' }),
  local('conflict', 35, 'Detect a conflicting payment observation', ['Pay through synthetic evidence.', 'Submit contradictory same-source evidence.', 'Verify the conflict is rejected and the paid Ticket is preserved.'], { scope: 'Detection subset. Guarded resolution and staff investigation routes are unavailable.' }),
  local('unknown-email', 37, 'Retain unknown dispatch for verification', ['Claim a new Ticket-email job.', 'Report unknown dispatch.', 'Verify requires_verification remains true.', 'Do not resend.'], { scope: 'Unknown-dispatch subset. Staff resend and automatic failure recovery remain unavailable.' }),
];
const reasons = {
  33: 'Full gate requires actual LMNL/provider/email and device evidence, beyond the Fake LMNL rehearsal.',
  34: 'Verification-frontier list and unattended provider recovery are not implemented.',
  35: 'Guarded resolution and operational investigation reads are not implemented.',
  36: 'Guarded retry and operational Order reads are not implemented; fault injection is not an HTTP capability.',
  37: 'Guarded resend and operational Order reads are not implemented.',
  38: 'Order recovery submission and temporary access generation are not implemented.',
  39: 'Verified delivery correction and token replacement are not implemented.',
  40: 'Event edits exist; per-recipient arrival-change notifications are not implemented.',
  41: 'Cancellation, cancellation notifications, and refund follow-up are not implemented.',
  42: 'Provider refund reports and refund eligibility are not implemented.',
  43: 'Operational lists, totals, actual fee reports and confirmations are not implemented.',
  44: 'Requires explicit operator connection switch, historical access and later refund/recovery routes.',
  45: 'Blocked by recovery implementation and real integration evidence in #34–44.',
  46: 'Access Request operations and private approval are not implemented.',
  47: 'Approval lookup and approval-bound checkout are not implemented.',
  48: 'Wallet data routes and Site signing/device integration are not implemented.',
  49: 'Wallet data routes, update jobs and device service are not implemented.',
  50: 'Quantity 2–8 and complete group issuance are not implemented; prior gates remain required.',
  51: 'Blocked by #50 and complete scenario, actual email/Wallet, permissions and physical-device evidence. This dashboard exports individual results; it cannot pass the release checklist.',
  52: 'Hosted SQL, callbacks and scheduled-worker evidence required. Local execution is disabled.',
  53: 'Hosted complete test-payment journeys and supported-device evidence required. Local execution is disabled.',
  54: 'Controlled cutover requires finished existing Events, closed sales, approved environment and preceding release checks. No production action exists here.',
  55: 'Explicit release-owner approval after all required evidence is mandatory. No sales-opening action exists here.',
};
export function ticketChecklist() {
  return tickets.map(t => ({
    number: t.number, title: t.title, implementationIssueState: t.state,
    url: `https://github.com/fvckzest/HP-OS/issues/${t.number}`,
    criteria: [...t.body.matchAll(/^- \[[ x]\] (.+)$/gm)].map(m => m[1]),
    gate: t.number >= 51 || [33, 44, 45].includes(t.number) ? 'blocked' : t.number >= 34 ? 'unavailable' : 'not run',
    reason: reasons[t.number] ?? 'Run individual workflows explicitly. A passing scenario does not complete every ticket acceptance criterion.',
  }));
}
export function documentedRoutes(...documents) {
  return [...new Set(documents.flatMap(s => [...s.matchAll(/`((?:GET|POST|PATCH|PUT|DELETE) \/v1\/[^`\s]+)`/g)].map(m => m[1])))].sort();
}
