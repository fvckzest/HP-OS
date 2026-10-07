import { Pause, Blocked, Unknown } from './adapter.mjs';
const human = { type: 'user', reference: 'fake-lmnl:local-staff' };
const system = { type: 'system', reference: 'fake-lmnl:local-worker' };
const iso = n => new Date(n).toISOString();
const id = x => encodeURIComponent(x);
export async function settleRequests(requests) {
  const results = await Promise.allSettled(requests);
  const rejected = results.filter(r => r.status === 'rejected');
  if (rejected.length) throw (rejected.find(r => r.reason instanceof Unknown) ?? rejected[0]).reason;
  return results.map(r => r.value);
}
async function configuration(a) {
  const { data } = await a.read('configuration', '/v1/admin/payment-configuration');
  const c = data?.active_connection;
  a.check('dedicated test connection', c?.connection_id === a.config.connectionId && c?.environment === 'test', 'Dedicated connection in test environment', c);
  if (a.run.profile === 'sandbox') {
    if (c.provider !== 'square' || c.account_reference !== a.config.squareAccountAlias || c.location_reference !== a.config.squareLocationAlias || c.account_eligibility_status !== 'eligible' || c.platform_fee_eligibility_status !== 'ineligible' || c.eligibility_evidence_reference === 'ref:fake-lmnl-simulation-only') throw new Blocked('Record independently verified Square Sandbox account eligibility and matching account/location aliases. Simulation-only setup cannot authorize real test integrations.');
    const location = await a.call('sandbox-location', `/v2/locations/${id(a.config.squareLocation)}`, { provider: 'square' });
    a.check('Sandbox location', location.envelope.location?.status === 'ACTIVE', 'Sandbox location is active', location.envelope.location?.status);
  }
  await a.read('historical-connection', `/v1/admin/payment-connections/${id(c.connection_id)}`);
  return c;
}
async function event(a, prefix = 'event', { ended = false, capacity = 8, futureCheckIn = false, auth = 'primary', visibility = 'public', checkInUsesEventStart = false, startOffsetMs = 300_000 } = {}) {
  const t = a.run.clock, start = ended ? t - 7_200_000 : t + startOffsetMs, end = ended ? t - 3_600_000 : t + 86_400_000;
  const draft = await a.write(prefix + '-draft', '/v1/admin/events', { actor: human }, [201], { auth });
  const p = `/v1/admin/events/${id(draft.data.event_id)}`;
  const saved = await a.call(prefix + '-save', p, { method: 'PATCH', auth, body: {
    actor: human, expected_version: draft.data.version, title: `Fake LMNL ${a.run.id.slice(0, 8)} ${prefix}`, description: 'Dedicated local synthetic workflow Event.', visibility,
    venue: { name: 'Fake LMNL local venue', address: null }, starts_at: iso(start), ends_at: iso(end), time_zone: 'UTC', check_in_opens_at: checkInUsesEventStart ? null : futureCheckIn ? iso(start) : iso(start - 600_000),
    ticket_offering: { price: { amount: 2500, currency: 'USD' }, tax_amount: 0, buyer_fees: [], capacity, sales_opens_at: iso(start - 600_000), sales_closes_at: iso(end) },
  } });
  const published = await a.write(prefix + '-publish', p + '/actions/publish', { actor: human, expected_version: saved.data.version }, [200], { auth });
  if (auth === 'primary') a.run.privateContext.event = published.data;
  await a.save(); return published.data;
}
async function reserve(a, e, prefix = 'purchase', auth = 'primary', buyerEmail = null, quantity = 1) {
  const quote = await a.write(prefix + '-quote', `/v1/public/events/${id(e.event_id)}/quotes`, { quantity }, [201], { auth });
  const order = await a.write(prefix + '-order', '/v1/public/orders', { quote_id: quote.data.quote_id, buyer: { name: 'Fake LMNL Buyer', email: buyerEmail || (a.run.profile === 'sandbox' ? a.config.operatorEmail : 'buyer@fake-lmnl.test') } }, [201], { auth });
  a.check(prefix + ': unpaid Order', order.data.payment_status === 'unpaid' && order.data.quantity === quantity && order.data.reservation?.quantity === quantity && order.data.tickets.length === 0, 'Unpaid Order and Reservation preserve the requested quantity, with no Tickets before payment', { payment: order.data.payment_status, quantity: order.data.quantity, reservation: order.data.reservation?.quantity, tickets: order.data.tickets.length });
  if (auth === 'primary') a.run.privateContext.order = order.data;
  await a.save(); return { quote: quote.data, order: order.data };
}
async function attempt(a, order, prefix = 'attempt', auth = 'primary') {
  const res = await a.write(prefix + '-create', `/v1/admin/orders/${id(order.order_id)}/payment-attempts`, { actor: system }, [201], { auth });
  a.check(prefix + ': frozen total', res.data.total.amount === order.pricing.total.amount && res.data.total.currency === order.pricing.total.currency && res.data.connection.environment === 'test', 'Attempt matches the accepted Order total and test connection', res.data.total);
  if (auth === 'primary') a.run.privateContext.attempt = res.data; await a.save(); return res.data;
}
async function checkout(a, at) {
  let reference = `fake-checkout-${a.run.id}`;
  if (a.run.profile === 'sandbox') {
    const link = await a.call('square-link', '/v2/online-checkout/payment-links', { provider: 'square', method: 'POST', body: {
      idempotency_key: a.run.id, quick_pay: { name: 'Fake LMNL local test Ticket', price_money: at.total, location_id: a.config.squareLocation }, checkout_options: { allow_tipping: false, enable_coupon: false, enable_loyalty: false },
    } });
    const l = link.envelope.payment_link;
    if (!l?.id || !l.order_id || !l.url) throw new Error('Square did not return a complete test checkout.');
    const order = await a.call('square-order', `/v2/orders/${id(l.order_id)}`, { provider: 'square' });
    a.check('Square accepted total', order.envelope.order?.total_money?.amount === at.total.amount && order.envelope.order?.total_money?.currency === at.total.currency && order.envelope.order?.location_id === a.config.squareLocation, 'Square Order matches exact accepted total, currency and location', order.envelope.order?.total_money);
    reference = l.id; a.run.privateContext.square = { link: l, orderId: l.order_id }; await a.save();
  }
  const registered = await a.write('checkout-register', `/v1/admin/payment-attempts/${id(at.attempt_id)}/checkout-reference`, { actor: system, connection_id: at.connection.connection_id, provider_checkout_reference: reference, provider_can_take_payment: true });
  a.check('registered before payment', registered.data.provider_checkout_reference === reference, 'Checkout registered before a payment report', registered.data.status);
  return reference;
}
async function paid(a, order, at, reference) {
  const pending = await a.read('buyer-pending', `/v1/public/orders/${id(order.order_token)}`);
  a.check('return is not payment', pending.data.payment_status === 'unpaid' && pending.data.tickets.length === 0, 'No Tickets before verified payment', { payment: pending.data.payment_status, tickets: pending.data.tickets.length });
  let payment = { id: `fake-payment-${a.run.id}`, created_at: iso(a.run.clock + 1000), updated_at: iso(a.run.clock + 1000) };
  if (a.run.profile === 'sandbox') {
    const supplied = a.run.privateContext.paymentId;
    if (!supplied) throw new Pause('Open the saved Square Sandbox checkout, complete a test payment, then enter its payment ID and Resume. No automatic polling occurs.');
    if (!/^[A-Za-z0-9_-]{1,192}$/.test(supplied)) throw new Blocked('Payment ID must be a Square reference.');
    const observed = await a.call('square-payment-' + supplied, `/v2/payments/${id(supplied)}`, { provider: 'square', fresh: !a.run.privateContext.paymentBody });
    payment = observed.envelope.payment;
    if (payment?.status !== 'COMPLETED') throw new Pause('Sandbox payment is not completed. Verify it in Square, then Resume.');
    a.check('verified Sandbox payment', payment.order_id === a.run.privateContext.square.orderId && payment.location_id === a.config.squareLocation && payment.amount_money?.amount === at.total.amount && payment.amount_money?.currency === at.total.currency && (payment.tip_money?.amount ?? 0) === 0, 'Completed payment matches this checkout, location and exact total without extra tip', { order: payment.order_id, amount: payment.amount_money, tip: payment.tip_money });
  }
  const body = a.run.privateContext.paymentBody ||= { connection_id: at.connection.connection_id, source_reference: `${a.run.profile}-payment-${payment.id}`, provider_checkout_reference: reference, provider_payment_reference: payment.id,
    outcome: 'paid', observed_at: payment.updated_at, payment_started_at: payment.created_at, provider_can_take_payment: false, amount: at.total.amount, currency: at.total.currency };
  await a.write('paid-report', `/v1/admin/payment-attempts/${id(at.attempt_id)}/payment-reports`, body, [201, 200]);
  let buyer = await a.read('issued-order', `/v1/public/orders/${id(order.order_token)}`, { fresh: true });
  if (buyer.data.issuance_status !== 'issued') { await a.scheduler('issuance-processing'); buyer = await a.read('recovered-order', `/v1/public/orders/${id(order.order_token)}`, { fresh: true }); }
  const expectedQuantity = order.quantity || 1, tickets = buyer.data.tickets;
  const uniqueIds = new Set(tickets.map(item => item.ticket_id)).size === expectedQuantity;
  const orderedOrdinals = tickets.every((item, index) => item.ordinal === index + 1);
  a.check('complete issuance', buyer.data.payment_status === 'paid' && buyer.data.issuance_status === 'issued' && tickets.length === expectedQuantity && uniqueIds && orderedOrdinals, `Paid Order has its complete set of ${expectedQuantity} Tickets with stable ordinals`, { payment: buyer.data.payment_status, issuance: buyer.data.issuance_status, quantity: expectedQuantity, tickets: tickets.length, uniqueIds, ordinals: tickets.map(item => item.ordinal) });
  const ticket = tickets[0];
  const uniqueTokens = new Set(tickets.map(item => item.ticket_token)).size === expectedQuantity;
  const uniqueQr = new Set(tickets.map(item => item.qr_payload)).size === expectedQuantity;
  a.check('distinct access scopes', uniqueTokens && uniqueQr && tickets.every(item => item.ticket_token !== order.order_token && item.ticket_token !== item.qr_payload && !item.qr_payload.includes('@')), 'Order token, each Ticket token and each QR are distinct; QR data has no email', { uniqueTokens, uniqueQr, quantity: expectedQuantity });
  const buyerTicket = await a.read('buyer-ticket', `/v1/public/tickets/${id(ticket.ticket_token)}`);
  a.check(
    'buyer Ticket page',
    buyerTicket.data.ticket_id === ticket.ticket_id
      && buyerTicket.data.qr_payload === ticket.qr_payload
      && buyerTicket.data.admission_status === 'unused'
      && buyerTicket.data.can_admit === true,
    'Buyer Ticket page exposes this Ticket QR and current unused Admission eligibility',
    {
      ticket_id: buyerTicket.data.ticket_id,
      qr_payload: buyerTicket.data.qr_payload,
      admission_status: buyerTicket.data.admission_status,
      can_admit: buyerTicket.data.can_admit,
    },
  );
  await a.read('staff-payment-status', `/v1/admin/orders/${id(order.order_id)}/payment-status`);
  await a.write('paid-report-duplicate-source', `/v1/admin/payment-attempts/${id(at.attempt_id)}/payment-reports`, body, [200]);
  const duplicate = await a.read('after-payment-replay', `/v1/public/orders/${id(order.order_token)}`, { fresh: true });
  a.check('no duplicate Ticket', duplicate.data.tickets.length === expectedQuantity && duplicate.data.tickets.map(item => item.ticket_id).join('|') === tickets.map(item => item.ticket_id).join('|'), 'Repeated report preserves the same complete Ticket set', duplicate.data.tickets.map(t => t.ticket_id));
  a.run.privateContext.ticket = ticket; a.run.privateContext.tickets = tickets; await a.save(); return { ticket, tickets, body };
}
async function fixture(a, { buyerEmail = null } = {}) {
  await configuration(a); const e = await event(a), { order } = await reserve(a, e, 'purchase', 'primary', buyerEmail), at = await attempt(a, order), reference = await checkout(a, at), payment = await paid(a, order, at, reference);
  return { e, order, at, reference, ...payment };
}
function savedStepData(run, name) {
  const step = run.steps.find(item => item.name === name);
  return step?.actual?.response?.data ?? null;
}
function savedNotificationJob(value, jobId) {
  if (Array.isArray(value)) return value.map(item => savedNotificationJob(item, jobId)).find(Boolean) ?? null;
  if (!value || typeof value !== 'object') return null;
  // Order reads return a summary without dispatch_attempts or delivery_reports.
  // The preceding outcome-report response carries that detailed evidence.
  if (value.job_id === jobId) return value;
  return Object.values(value).map(item => savedNotificationJob(item, jobId)).find(Boolean) ?? null;
}
function provesSimulatedNoDispatch(run, jobId) {
  if (run.profile !== 'simulation' || run.status !== 'passed') return false;
  if (!Array.isArray(run.steps) || run.steps.some(step => step.provider !== 'hpos')) return false;
  const reportPath = `/v1/admin/notification-jobs/${id(jobId)}/outcome-reports`;
  const reportIndex = run.steps.findIndex(step => step.method === 'POST'
    && step.path === reportPath
    && step.request?.outcome === 'unknown'
    && step.request.provider_message_reference === null);
  if (reportIndex < 0) return false;
  const reportStep = run.steps[reportIndex];
  const claimId = reportStep.request.claim_id;
  const claimedStep = run.steps.find(step => step.method === 'POST'
    && step.path === '/v1/admin/notification-jobs/claims'
    && step.actual?.response?.data?.claim_id === claimId);
  const claim = claimedStep?.actual?.response?.data;
  const claimed = claim?.jobs?.find(item => item.job_id === jobId);
  const reported = reportStep.actual?.response?.data;
  const observedStep = run.steps.slice(reportIndex + 1).find(step => step.method === 'GET'
    && step.actual?.status === 200
    && savedNotificationJob(step.actual?.response?.data, jobId));
  const observed = savedNotificationJob(observedStep?.actual?.response?.data, jobId);
  const reportedAttempt = reported?.dispatch_attempts?.at(-1);
  const noProviderReference = attempts => Array.isArray(attempts) && attempts.length > 0
    && attempts.every(attempt => attempt.outcome === 'unknown' && attempt.provider_message_reference === null);
  return claimedStep?.actual?.status === 200 && Boolean(claim?.claim_id) && claimed?.job_id === jobId
    && reportStep.actual?.status === 200
    && reportStep.request?.claim_id === claimId && claimId === claim.claim_id
    && reportStep.request?.lease_fence === claimed.lease_fence
    && observedStep?.actual?.status === 200
    && reported?.job_id === jobId && reported.requires_verification === true
    && reported.provider_message_reference === null && noProviderReference(reported.dispatch_attempts)
    && reportedAttempt?.outcome === 'unknown'
    && reportedAttempt.claim_id === claim.claim_id && reportedAttempt.lease_fence === claimed.lease_fence
    && reportedAttempt.provider_message_reference === null
    && observed?.job_id === jobId && observed.requires_verification === true
    && observed.provider_message_reference === null
    && Array.isArray(reported.delivery_reports) && reported.delivery_reports.length === 0;
}
async function verifiedSimulationUnknowns(a, frontier) {
  const pending = frontier.filter(job => job.status !== 'completed' && job.requires_verification);
  const proofs = new Map();
  if (!pending.length) return proofs;
  if (a.run.profile !== 'simulation') {
    throw new Blocked('Unfinished jobs require provider or durable-log verification. Resolve their saved runs first; no blind resend is permitted.');
  }
  const savedRuns = await a.store.all();
  for (const job of pending) {
    const sourceRun = savedRuns.find(run => provesSimulatedNoDispatch(run, job.job_id));
    if (!sourceRun) {
      throw new Blocked(`Notification job ${job.job_id} requires verification. No matching saved Local simulation run proves that a provider dispatch was not made; no resend was attempted.`);
    }
    a.check(`saved simulation proves no provider dispatch ${job.job_id}`, true,
      'The matching passed saved run used only the HP-OS API and recorded an unknown result without a provider message or delivery report',
      { job_id: job.job_id, saved_run_id: sourceRun.id, profile: sourceRun.profile, workflow: sourceRun.workflow });
    proofs.set(job.job_id, sourceRun.id);
  }
  return proofs;
}
async function deliver(a, f, { unknown = false, overlap = false, failure = false } = {}) {
  const jobs = await a.read('email-list', `/v1/admin/notification-jobs?order_id=${id(f.order.order_id)}&kind=tickets_ready`);
  const job = jobs.data.find(j => j.order_id === f.order.order_id && j.kind === 'tickets_ready');
  a.check('initial email job', jobs.data.length === 1 && Boolean(job), 'Exactly one initial email job for this Order', jobs.data.length);
  const frontier = await a.read('email-frontier', '/v1/admin/notification-jobs?kind=tickets_ready&limit=100', { fresh: true });
  if (frontier.envelope.pagination?.next_cursor) throw new Blocked('The worker frontier exceeds this bounded 100-job run. Resolve preceding work first.');
  const verifiedUnknowns = await verifiedSimulationUnknowns(a, frontier.data);
  if (a.run.profile === 'sandbox' && frontier.data.some(j => j.job_id !== job.job_id && j.status !== 'completed')) throw new Blocked('Other unfinished Ticket-email jobs exist. Resolve preceding simulated runs first; Sandbox cannot send unrelated notifications.');
  const claim = await a.write('email-claim', '/v1/admin/notification-jobs/claims', { actor: system, limit: 100, kinds: ['tickets_ready'] });
  const claimed = claim.data.jobs.find(j => j.job_id === job.job_id);
  if (!claimed) throw new Blocked('Target job is not claimable. Recover its existing claim before dispatch.');
  if (a.run.profile === 'simulation') for (const preceding of claim.data.jobs.filter(j => j.job_id !== job.job_id)) {
    if (preceding.requires_verification && !verifiedUnknowns.has(preceding.job_id)) throw new Blocked('A newly claimed job requires provider or durable-log verification. No blind simulated resend.');
    const reference = `fake-email-${preceding.job_id}`;
    await a.write('backlog-dispatch-' + preceding.job_id, `/v1/admin/notification-jobs/${id(preceding.job_id)}/outcome-reports`, { actor: system, claim_id: claim.data.claim_id, lease_fence: preceding.lease_fence, outcome: 'completed', provider_message_reference: reference, observed_at: iso(a.run.clock + 2000), error_code: null });
    await a.write('backlog-delivery-' + preceding.job_id, `/v1/admin/notification-jobs/${id(preceding.job_id)}/delivery-reports`, { actor: system, outcome: 'delivered', provider_message_reference: reference, provider_event_reference: `fake-delivery-${preceding.job_id}`, observed_at: iso(a.run.clock + 3000) });
  }
  if (overlap) {
    await a.write('email-renew', `/v1/admin/notification-jobs/claims/${id(claim.data.claim_id)}/renew`, { actor: system });
    const other = await a.write('email-overlap', '/v1/admin/notification-jobs/claims', { actor: system, limit: 100, kinds: ['tickets_ready'] });
    a.check('exclusive lease', !other.data.jobs.some(j => j.job_id === job.job_id), 'Overlapping worker cannot claim this job', other.data.jobs.map(j => j.job_id));
  }
  const recheck = await a.read('email-recheck', `/v1/admin/notification-jobs/${id(job.job_id)}`, { fresh: true });
  if (!a.run.journal['email-dispatch'] && (recheck.data.is_superseded || recheck.data.requires_verification || recheck.data.claim_id !== claim.data.claim_id || recheck.data.lease_fence !== claimed.lease_fence || Date.parse(recheck.data.lease_expires_at) <= Date.now())) throw new Blocked('Current job or claim is no longer eligible for dispatch. Verify history and recover the lease before sending.');
  let messageReference = `fake-email-${job.job_id}`;
  if (a.run.profile === 'sandbox' && !unknown) {
    if (claimed.requires_verification && !a.run.journal['resend-send']) throw new Blocked('Dispatch requires verification; no blind resend is allowed.');
    const sent = await a.call('resend-send', '/emails', { provider: 'resend', method: 'POST', key: `fake-lmnl/${job.job_id}`, body: {
      from: a.config.resendFrom, to: [a.config.operatorEmail], subject: 'Fake LMNL local test Ticket', text: `Local test only. Order: http://127.0.0.1:3100/buyer/order/${a.run.id}\nTicket: http://127.0.0.1:3100/buyer/ticket/${a.run.id}\nThese links require this local Docker dashboard.`,
    }, expected: [200, 201] });
    messageReference = sent.envelope.id;
    a.check('Resend send reference', Boolean(messageReference), 'Send returned a dispatch ID, separate from delivery', { hasReference: Boolean(messageReference) });
  }
  await a.write('email-dispatch', `/v1/admin/notification-jobs/${id(job.job_id)}/outcome-reports`, { actor: system, claim_id: claim.data.claim_id, lease_fence: claimed.lease_fence, outcome: unknown ? 'unknown' : 'completed', provider_message_reference: unknown ? null : messageReference, observed_at: iso(a.run.clock + 2000), error_code: unknown ? 'provider_unavailable' : null });
  if (unknown) {
    const observed = await a.read('unknown-job', `/v1/admin/notification-jobs/${id(job.job_id)}`);
    a.check('unknown retained', observed.data.requires_verification === true && observed.data.status !== 'completed', 'Unknown remains unresolved and requires verification; no resend', { requiresVerification: observed.data.requires_verification, status: observed.data.status }); return;
  }
  let observedAt = iso(a.run.clock + 3000);
  if (a.run.profile === 'sandbox') {
    const observed = await a.call('resend-delivery', `/emails/${id(messageReference)}`, { provider: 'resend', fresh: true }), email = observed.envelope;
    if (email.last_event !== 'delivered') throw new Pause('Dispatch completed; delivery is pending. Resume to retrieve Resend status. No automatic polling or resend.');
    a.check('operator-only email', email.to?.length === 1 && email.to[0].toLowerCase() === a.config.operatorEmail.toLowerCase(), 'Retrieved recipient matches the configured operator', { recipientMatched: true });
    observedAt = a.run.privateContext.deliveryObservedAt ||= new Date().toISOString();
  } else {
    const status = await a.read('sent-not-delivered', `/v1/admin/orders/${id(f.order.order_id)}/payment-status`);
    a.check('sent is distinct from delivered', status.data.delivery_status !== 'delivered', 'Dispatch alone does not assert delivery', status.data.delivery_status);
  }
  if (failure) {
    const sentOrder = await a.read('sent-order-before-failure', `/v1/admin/orders/${id(f.order.order_id)}`, { fresh: true });
    await a.write('correction-before-delivery', `/v1/admin/orders/${id(f.order.order_id)}/actions/correct_delivery_email`, {
      actor: human,
      expected_version: sentOrder.data.version,
      email: `sent-${a.run.id.slice(0, 8)}@example.test`,
      reason: 'Buyer verified the corrected address through the Site staff workflow.',
      verification_reference: `fake-sent-verification-${a.run.id}`,
    }, [409], { expectedError: 'delivery_verification_required' });
    await a.write('email-failed', `/v1/admin/notification-jobs/${id(job.job_id)}/delivery-reports`, { actor: system, outcome: 'failed', provider_message_reference: messageReference, provider_event_reference: `${a.run.profile}-observed-failure-${job.job_id}`, observed_at: observedAt });
    const failed = await a.read('failed-order', `/v1/admin/orders/${id(f.order.order_id)}`, { fresh: true });
    a.check('delivery failure retained', failed.data.delivery_status === 'failed', 'A failed delivery remains visible without invalidating the Ticket', failed.data.delivery_status);
    const resend = await a.write('resend-failed-email', `/v1/admin/orders/${id(f.order.order_id)}/actions/resend_ticket_email`, { actor: human, expected_version: failed.data.version }, [202]);
    a.check('resend preserves Ticket', resend.data.tickets.length === 1 && resend.data.tickets[0].ticket_id === f.ticket.ticket_id
      && resend.data.notification_jobs.filter(item => item.kind === 'tickets_ready').length === 2,
    'A guarded resend queues another email while retaining the original Ticket and failed history', {
      tickets: resend.data.tickets.length,
      jobs: resend.data.notification_jobs.filter(item => item.kind === 'tickets_ready').length,
    });
    return resend.data;
  }
  await a.write('email-delivered', `/v1/admin/notification-jobs/${id(job.job_id)}/delivery-reports`, { actor: system, outcome: 'delivered', provider_message_reference: messageReference, provider_event_reference: `${a.run.profile}-observed-delivery-${job.job_id}`, observed_at: observedAt });
  const after = await a.read('delivered-order', `/v1/public/orders/${id(f.order.order_token)}`, { fresh: true });
  a.check('delivery observed', after.data.delivery_status === 'delivered', 'Delivery has separate evidence', after.data.delivery_status);
}

async function deliveryRecovery(a, f, { issue39 = false } = {}) {
  await a.write('admit-before-delivery-correction', `/v1/admin/events/${id(f.e.event_id)}/admissions`, { actor: human, qr_token: f.ticket.qr_payload }, [201]);
  const afterResend = await deliver(a, f, { failure: true });
  const resendJob = afterResend.notification_jobs.filter(item => item.kind === 'tickets_ready').at(-1);
  await a.write('correction-while-pending', `/v1/admin/orders/${id(f.order.order_id)}/actions/correct_delivery_email`, {
    actor: human,
    expected_version: afterResend.version,
    email: `pending-${a.run.id.slice(0, 8)}@example.test`,
    reason: 'Buyer verified the corrected address through the Site staff workflow.',
    verification_reference: `fake-pending-verification-${a.run.id}`,
  }, [409], { expectedError: 'delivery_in_progress' });
  const resendClaim = await a.write('resend-email-claim', '/v1/admin/notification-jobs/claims', { actor: system, limit: 100, kinds: ['tickets_ready'] });
  const claimedResend = resendClaim.data.jobs.find(item => item.job_id === resendJob?.job_id);
  if (!claimedResend) throw new Blocked('The resent Ticket-email job is not claimable. Resolve its existing claim before testing address correction.');
  await a.write('resend-email-completed', `/v1/admin/notification-jobs/${id(resendJob.job_id)}/outcome-reports`, {
    actor: system, claim_id: resendClaim.data.claim_id, lease_fence: claimedResend.lease_fence,
    outcome: 'completed', provider_message_reference: `fake-resend-${resendJob.job_id}`, observed_at: iso(a.run.clock + 2000), error_code: null,
  });
  await a.write('resend-email-failed', `/v1/admin/notification-jobs/${id(resendJob.job_id)}/delivery-reports`, {
    actor: system, outcome: 'failed', provider_message_reference: `fake-resend-${resendJob.job_id}`,
    provider_event_reference: `${a.run.profile}-resend-failure-${resendJob.job_id}`, observed_at: iso(a.run.clock + 3000),
  });
  const failedResend = await a.read('failed-resend-order', `/v1/admin/orders/${id(f.order.order_id)}`, { fresh: true });
  const correctedEmail = `corrected-${a.run.id.slice(0, 8)}@example.test`;
  let claimedRecovery = null;
  if (issue39) {
    await a.write('recovery-request-before-correction', '/v1/public/order-recovery', { email: f.order.delivery_email }, [202]);
    const recoveryJobs = await a.read('recovery-job-before-correction', '/v1/admin/notification-jobs?kind=order_recovery', { fresh: true });
    const recoveryJob = recoveryJobs.data.find(item => item.kind === 'order_recovery'
      && item.payload?.recipient_email?.toLowerCase() === f.order.delivery_email.toLowerCase()
      && item.payload?.orders?.some(order => order.order_id === f.order.order_id));
    const recoveryOrder = recoveryJob?.payload?.orders?.find(order => order.order_id === f.order.order_id);
    if (!recoveryJob || !recoveryOrder) throw new Blocked('The current delivery address did not produce a temporary recovery link for the correction race check.');
    if (recoveryJobs.data.some(item => item.job_id !== recoveryJob.job_id
      && item.kind === 'order_recovery' && item.status === 'pending' && !item.is_superseded)) {
      throw new Blocked('Other Order recovery jobs are pending on this Site. Resolve them before claiming the correction-race fixture.');
    }
    const recoveryClaim = await a.write('recovery-email-claim-before-correction', '/v1/admin/notification-jobs/claims', { actor: system, limit: 100, kinds: ['order_recovery'] });
    claimedRecovery = recoveryClaim.data.jobs.find(item => item.job_id === recoveryJob.job_id);
    if (!claimedRecovery) throw new Blocked('The temporary recovery email could not be claimed before correction.');
    claimedRecovery.orderToken = recoveryOrder.order_token;
  }
  const corrected = await a.write('correct-delivery-email', `/v1/admin/orders/${id(f.order.order_id)}/actions/correct_delivery_email`, {
    actor: human,
    expected_version: failedResend.data.version,
    email: correctedEmail,
    reason: 'Buyer verified the corrected address through the Site staff workflow.',
    verification_reference: `fake-verification-${a.run.id}`,
  }, [202]);
  a.check('correction preserves identities', corrected.data.delivery_email === correctedEmail
    && corrected.data.checkout_identity.email === f.order.delivery_email
    && corrected.data.tickets.length === 1
    && corrected.data.tickets[0].ticket_id === f.ticket.ticket_id,
  'Verified correction changes current delivery while preserving checkout identity and Ticket identity', {
    deliveryEmail: corrected.data.delivery_email,
    ticketId: corrected.data.tickets[0]?.ticket_id,
  });
  const jobs = await a.read('corrected-email-jobs', `/v1/admin/notification-jobs?order_id=${id(f.order.order_id)}&kind=tickets_ready`, { fresh: true });
  const current = jobs.data.find(item => item.kind === 'tickets_ready' && !item.is_superseded);
  const correctionReason = 'Buyer verified the corrected address through the Site staff workflow.';
  const correctionVerification = `fake-verification-${a.run.id}`;
  a.check('old access replaced', current?.payload?.recipient_email === correctedEmail
    && jobs.data.length === 3
    && (await a.read('old-order-token', `/v1/public/orders/${id(f.order.order_token)}`, { expected: [404], expectedError: 'not_found' })).status === 404,
  'Correction retains history, queues current-address delivery, and invalidates the old Order link', {
    jobs: jobs.data.length,
    currentRecipient: current?.payload?.recipient_email,
  });
  if (issue39) {
    const oldRecoveryPage = await a.read('claimed-recovery-link-revoked', `/v1/public/orders/${id(claimedRecovery.orderToken)}`, { expected: [404], expectedError: 'not_found' });
    const oldAddressLookup = await a.write('staff-lookup-old-address', `/v1/admin/events/${id(f.e.event_id)}/ticket-lookup`, { email: f.order.delivery_email });
    const correctedAddressLookup = await a.write('staff-lookup-corrected-address', `/v1/admin/events/${id(f.e.event_id)}/ticket-lookup`, { email: correctedEmail });
    a.check('Site Buyer lookup follows corrected address', oldAddressLookup.data.length === 0
      && correctedAddressLookup.data.length === 1
      && correctedAddressLookup.data[0].order_reference === f.order.order_reference
      && correctedAddressLookup.data[0].tickets[0].ticket_id === f.ticket.ticket_id,
    'Staff lookup finds the same Order and Ticket only through the corrected current email', {
      oldAddressMatches: oldAddressLookup.data.length,
      correctedAddressMatches: correctedAddressLookup.data.length,
      ticketId: correctedAddressLookup.data[0]?.tickets[0]?.ticket_id,
    });
    a.check('claimed recovery access revoked', oldRecoveryPage.status === 404,
      'The temporary page link from the claimed old-address email no longer opens after correction', oldRecoveryPage.status);
    await a.write('claimed-stale-recovery-worker-skipped', `/v1/admin/notification-jobs/${id(claimedRecovery.job_id)}/outcome-reports`, {
      actor: system, claim_id: claimedRecovery.claim_id, lease_fence: claimedRecovery.lease_fence,
      outcome: 'failed', provider_message_reference: null, observed_at: iso(a.run.clock + 3500),
      error_code: 'ORDER_RECOVERY_LINK_UNAVAILABLE', failure_class: 'permanent',
    });
  }
  const claim = await a.write('corrected-email-claim', '/v1/admin/notification-jobs/claims', { actor: system, limit: 100, kinds: ['tickets_ready'] });
  const claimed = claim.data.jobs.find(item => item.job_id === current?.job_id);
  if (!claimed) throw new Blocked('The corrected Ticket-email job is not claimable. Resolve its existing claim before testing unknown recovery.');
  await a.write('corrected-email-unknown', `/v1/admin/notification-jobs/${id(current.job_id)}/outcome-reports`, {
    actor: system, claim_id: claim.data.claim_id, lease_fence: claimed.lease_fence,
    outcome: 'unknown', provider_message_reference: null, observed_at: iso(a.run.clock + 4000), error_code: 'provider_unavailable',
  });
  const unresolved = await a.read('unknown-after-correction', `/v1/admin/orders/${id(f.order.order_id)}`, { fresh: true });
  await a.write('blind-resend-blocked', `/v1/admin/orders/${id(f.order.order_id)}/actions/resend_ticket_email`, { actor: human, expected_version: unresolved.data.version }, [409], { expectedError: 'delivery_verification_required' });
  const unresolvedJob = unresolved.data.notification_jobs.find(item => item.job_id === current.job_id && !item.is_superseded);
  a.check('unknown blocks resend', unresolvedJob?.requires_verification === true,
    'An unknown dispatch remains unresolved and blocks a blind resend', unresolvedJob);
  const correctedOrder = await a.read('corrected-order-page', `/v1/public/orders/${id(current.payload.order.order_token)}`, { fresh: true });
  const replacementTicket = correctedOrder.data.tickets.find(ticket => ticket.ticket_id === f.ticket.ticket_id);
  const oldTicket = await a.read('old-ticket-token', `/v1/public/tickets/${id(f.ticket.ticket_token)}`, { expected: [404], expectedError: 'not_found' });
  const replacementPage = replacementTicket
    ? await a.read('replacement-ticket-page', `/v1/public/tickets/${id(replacementTicket.ticket_token)}`, { fresh: true })
    : { data: {}, status: 0 };
  a.check('replacement preserves admission history', correctedOrder.status === 200
    && replacementTicket?.qr_payload === f.ticket.qr_payload
    && replacementPage.data.ticket_id === f.ticket.ticket_id
    && replacementPage.data.qr_payload === f.ticket.qr_payload
    && replacementPage.data.admission_status === 'admitted'
    && replacementPage.data.can_admit === false
    && oldTicket.status === 404,
  'The replacement Order and Ticket pages preserve QR and Admission history while the old Ticket token is invalid', {
    replacementTicket: replacementTicket?.ticket_id,
    admission: replacementPage.data.admission_status,
    oldTicketStatus: oldTicket.status,
  });
  if (issue39) {
    const oldQrReplay = await a.write('old-qr-after-correction', `/v1/admin/events/${id(f.e.event_id)}/admissions`, {
      actor: human, qr_token: f.ticket.qr_payload,
    }, [409], { expectedError: 'already_admitted' });
    a.check('old QR keeps Admission history', oldQrReplay.error?.code === 'already_admitted',
      'The same QR remains subject to its pre-correction Admission record', oldQrReplay.error?.code);
  }
  a.check('correction audit recorded', unresolved.data.recovery_actions.some(action => action.action === 'correct_delivery_email'
    && action.reason === correctionReason && action.verification_reference === correctionVerification),
  'Delivery-email correction records its reason and verification reference', unresolved.data.recovery_actions);
}
async function admit(a, f, { concurrency = false } = {}) {
  const p = `/v1/admin/events/${id(f.e.event_id)}`;
  const lookup = await a.write('lookup-reference', p + '/ticket-lookup', { order_reference: f.order.order_reference });
  a.check('lookup no page secrets', !/order_token|ticket_token|qr_payload|qr_token/.test(JSON.stringify(lookup.envelope)), 'Staff lookup contains no access tokens or QR', { orders: lookup.data.length });
  await a.write('lookup-email', p + '/ticket-lookup', { email: a.run.profile === 'sandbox' ? a.config.operatorEmail : 'buyer@fake-lmnl.test' });
  await a.write('invalid-qr', p + '/admissions', { actor: human, qr_token: 'A'.repeat(32) }, [404], { expectedError: 'not_found' });
  if (concurrency) {
    const wrong = await event(a, 'wrong-event');
    await a.write('wrong-event-qr', `/v1/admin/events/${id(wrong.event_id)}/admissions`, { actor: human, qr_token: f.ticket.qr_payload }, [409], { expectedError: 'ticket_event_mismatch' });
  }
  const body = { actor: human, qr_token: f.ticket.qr_payload }, names = concurrency ? ['scan-one', 'scan-two'] : ['scan-one'];
  const responses = await settleRequests(names.map(name => a.write(name, p + '/admissions', body, concurrency ? [201, 409] : [201])));
  const winner = responses.findIndex(r => r.status === 201);
  a.check('one Admission', responses.filter(r => r.status === 201).length === 1 && (!concurrency || responses.some(r => r.error?.code === 'already_admitted')), 'Exactly one successful Admission', responses.map(r => ({ status: r.status, error: r.error?.code })));
  const replay = await a.write('scan-replay', p + '/admissions', body, [201], { key: a.run.journal[names[winner]].key });
  a.check('replayed Admission identity', replay.data.admission_id === responses[winner].data.admission_id, 'Original key returns original Admission', replay.data.admission_id);
  await a.write('scan-again', p + '/admissions', body, [409], { expectedError: 'already_admitted' });
  await a.write('manual-again', p + '/admissions', { actor: human, ticket_id: f.ticket.ticket_id }, [409], { expectedError: 'already_admitted' });
  const after = await a.read('after-admission', `/v1/public/tickets/${id(f.ticket.ticket_token)}`, { fresh: true });
  a.check('current Admission', after.data.admission_status === 'admitted' && after.data.can_admit === false, 'Buyer Ticket shows admitted and cannot admit again', { status: after.data.admission_status, canAdmit: after.data.can_admit });
}
async function closure(a) {
  await configuration(a); const e = await event(a), { order } = await reserve(a, e), at = await attempt(a, order);
  await a.read('attempt-inspection', `/v1/admin/payment-attempts/${id(at.attempt_id)}`);
  await a.write('concurrent-attempt', `/v1/admin/orders/${id(order.order_id)}/payment-attempts`, { actor: system }, [409], { expectedError: 'payment_attempt_in_progress' });
  const reference = await checkout(a, at);
  await a.write('closure-report', `/v1/admin/payment-attempts/${id(at.attempt_id)}/closure-reports`, { actor: system, connection_id: at.connection.connection_id, source_reference: `fake-closure-${a.run.id}`, provider_checkout_reference: reference, observed_at: iso(a.run.clock + 1000), provider_checkout_closed: true, payment_outcome: 'canceled' });
  const next = await attempt(a, order, 'replacement');
  a.check('distinct replacement', next.attempt_id !== at.attempt_id, 'Verified closure permits a distinct replacement', next.attempt_id);
  await a.write('unsafe-setup-failure', `/v1/admin/payment-attempts/${id(next.attempt_id)}/setup-failure`, { actor: system, reason: 'provider_unavailable', provider_checkout_closed: false, payment_outcome: 'not_started' }, [422]);
  await a.write('safe-setup-failure', `/v1/admin/payment-attempts/${id(next.attempt_id)}/setup-failure`, { actor: system, reason: 'provider_unavailable', provider_checkout_closed: true, payment_outcome: 'not_started' });
  const after = await a.read('capacity-after-setup-failure', `/v1/admin/events/${id(e.event_id)}`);
  a.check('Reservation released', after.data.ticket_offering.available_quantity === e.ticket_offering.available_quantity, 'Safe setup failure restores availability', after.data.ticket_offering.available_quantity);
}
async function recoveryFrontier(a) {
  await configuration(a);
  const e = await event(a, 'recovery-frontier');
  const { order } = await reserve(a, e, 'recovery-frontier');
  const at = await attempt(a, order, 'recovery-frontier');
  const reference = await checkout(a, at);
  await a.write('unknown-payment', `/v1/admin/payment-attempts/${id(at.attempt_id)}/payment-reports`, {
    connection_id: at.connection.connection_id,
    source_reference: `fake-unknown-${a.run.id}`,
    provider_checkout_reference: reference,
    provider_payment_reference: null,
    outcome: 'unknown',
    observed_at: iso(a.run.clock + 1000),
    payment_started_at: null,
    provider_can_take_payment: null,
  }, [201]);
  const frontier = await a.read('verification-frontier', '/v1/admin/payment-attempts?requires_verification=true&limit=100');
  const discovered = frontier.data.find(row => row.attempt_id === at.attempt_id);
  a.check('verification frontier', discovered?.requires_verification === true
    && discovered.provider_checkout_reference === reference
    && discovered.connection?.connection_id === at.connection.connection_id
    && Date.parse(discovered.checkout_expires_at) === Date.parse(order.checkout_expires_at),
  'The Site can discover the unresolved attempt with its frozen connection and deadline', discovered);
  await a.write('replacement-blocked', `/v1/admin/orders/${id(order.order_id)}/payment-attempts`, { actor: system }, [409], { expectedError: 'payment_attempt_in_progress' });
  const scheduled = await a.scheduler('verification-frontier-scheduler');
  a.check('scheduler verification count', Number.isInteger(scheduled.data.verification_required_attempts), 'The bounded scheduler reports payment attempts promoted for verification', scheduled.data.verification_required_attempts);
}

async function createApprovedPrivateRequest(a, prefix = 'private') {
  const e = await event(a, prefix + '-event', { visibility: 'private' });
  const attendee = {
    name: 'Fake LMNL Attendee ' + a.run.id.slice(0, 8),
    email: 'attendee-' + a.run.id.slice(0, 8) + '@fake-lmnl.test',
  };
  await a.write(prefix + '-request', '/v1/public/events/' + id(e.event_id) + '/access-requests', attendee, [201]);
  const list = await a.read(prefix + '-request-list', '/v1/admin/events/' + id(e.event_id) + '/access-requests?limit=100');
  const request = list.data.find(item => item.status === 'pending' && item.email === attendee.email);
  if (!request) throw new Blocked('The submitted attendee request is not visible to this Site.');
  const before = await a.read(prefix + '-capacity-before', '/v1/admin/events/' + id(e.event_id));
  const decision = await a.write(prefix + '-approve', '/v1/admin/access-requests/' + id(request.request_id) + '/actions/approve', {
    actor: human, expected_version: request.version,
  });
  const jobs = await a.read(prefix + '-approval-job', '/v1/admin/notification-jobs?event_id=' + id(e.event_id) + '&kind=access_approved&limit=100');
  const job = jobs.data.find(item => item.access_request_id === request.request_id && !item.is_superseded);
  const token = job?.payload?.approval_token;
  if (!token) throw new Blocked('Approval produced no current Site-side approval-link job.');
  const lookup = await a.read(prefix + '-approval-link', '/v1/public/access-requests/' + id(token));
  a.check(prefix + ': approved attendee', lookup.data.approved_attendee?.name === attendee.name
    && lookup.data.approved_attendee?.email === attendee.email
    && lookup.data.max_quantity_per_order === 1,
  'The approval link contains the approved attendee and one-Ticket limit', lookup.data);
  a.check(prefix + ': approval does not reserve', before.data.ticket_offering.available_quantity === e.ticket_offering.available_quantity,
    'Approval creates no capacity Reservation', before.data.ticket_offering.available_quantity);
  a.run.privateContext.accessRequest = decision.data;
  a.run.privateContext.approvalToken = token;
  await a.save();
  return { e, attendee, request: decision.data, token, approvalJob: job };
}
async function arrivalChange(a) {
  await configuration(a);
  const e = await event(a, 'arrival-change', { checkInUsesEventStart: true, startOffsetMs: -600_000 });
  const { order } = await reserve(a, e, 'arrival-purchase');
  const at = await attempt(a, order, 'arrival-attempt');
  const reference = await checkout(a, at);
  const { ticket } = await paid(a, order, at, reference);
  const before = await a.read('arrival-event-before', '/v1/admin/events/' + id(e.event_id));
  const starts = Date.parse(before.data.starts_at) + 3_600_000;
  const ends = Date.parse(before.data.ends_at) + 3_600_000;
  const edited = await a.call('arrival-event-edit', '/v1/admin/events/' + id(e.event_id), {
    method: 'PATCH',
    body: {
      actor: human, expected_version: before.data.version,
      starts_at: iso(starts), ends_at: iso(ends), time_zone: 'America/Los_Angeles',
      venue: { name: 'Fake LMNL updated venue', address: '100 Synthetic Street' },
    },
  });
  a.check('default check-in follows start', edited.data.check_in_uses_event_start === true
    && Date.parse(edited.data.check_in_opens_at) === Date.parse(edited.data.starts_at),
  'Default check-in opening follows the edited Event start', { usesEventStart: edited.data.check_in_uses_event_start, opensAt: edited.data.check_in_opens_at, startsAt: edited.data.starts_at });
  const changed = await a.read('arrival-notifications', '/v1/admin/notification-jobs?event_id=' + id(e.event_id) + '&kind=event_changed&limit=100');
  const job = changed.data.find(item => item.order_id === order.order_id && !item.is_superseded);
  const expectedFields = ['ends_at', 'starts_at', 'time_zone', 'venue.address', 'venue.name'];
  a.check('per-Order Event change job', Boolean(job) && job.payload?.event?.changed_fields?.slice().sort().join('|') === expectedFields.join('|'),
    'One durable notification records the exact changed Event fields for the paid Order', job?.payload?.event?.changed_fields);
  const publicWallet = await a.read('arrival-wallet-data', '/v1/public/tickets/' + id(ticket.ticket_token) + '/apple-wallet-data');
  const walletJobs = await a.read('arrival-wallet-jobs', '/v1/admin/notification-jobs?kind=wallet_update&limit=100');
  const walletJob = walletJobs.data.find(item => item.ticket_id === ticket.ticket_id && !item.is_superseded);
  a.check('Event edit queues Wallet version', Boolean(walletJob)
    && walletJob.payload?.data_version === publicWallet.data.data_version,
  'Wallet update work carries the current unsigned Ticket data version', walletJob?.payload);
}
async function cancelEvent(a) {
  await configuration(a);
  const e = await event(a, 'cancellation', { capacity: 2 });
  const { order: paidOrder } = await reserve(a, e, 'cancellation-paid');
  const at = await attempt(a, paidOrder, 'cancellation-attempt');
  const reference = await checkout(a, at);
  const { ticket } = await paid(a, paidOrder, at, reference);
  const { order: unpaidOrder } = await reserve(a, e, 'cancellation-unpaid');
  const currentEvent = await a.read('cancellation-event-current', '/v1/admin/events/' + id(e.event_id));
  const canceled = await a.write('cancel-event', '/v1/admin/events/' + id(e.event_id) + '/actions/cancel', {
    actor: human, expected_version: currentEvent.data.version,
  });
  a.check('Event canceled', canceled.data.is_canceled === true && canceled.data.sales_status === 'canceled',
    'Cancellation stops sales while preserving the Event record', { canceled: canceled.data.is_canceled, salesStatus: canceled.data.sales_status });
  const paidAdmin = await a.read('canceled-paid-order', '/v1/admin/orders/' + id(paidOrder.order_id));
  const unpaidAdmin = await a.read('canceled-unpaid-order', '/v1/admin/orders/' + id(unpaidOrder.order_id));
  a.check('cancellation is not a refund', paidAdmin.data.refund_status === 'none',
    'Canceling an Event does not report or imply a provider refund', paidAdmin.data.refund_status);
  a.check('safe unpaid Reservation released', unpaidAdmin.data.reservation.status === 'released',
    'An unpaid Order with no provider checkout releases its Reservation safely', unpaidAdmin.data.reservation);
  const notices = await a.read('cancellation-notifications', '/v1/admin/notification-jobs?event_id=' + id(e.event_id) + '&kind=event_canceled&limit=100');
  a.check('paid Order cancellation notice queued', notices.data.filter(item => item.order_id === paidOrder.order_id && !item.is_superseded).length === 1,
    'One durable cancellation notice is queued for the paid Order', notices.data.map(item => ({ kind: item.kind, order_id: item.order_id })));
  await a.write('admission-after-cancel', '/v1/admin/events/' + id(e.event_id) + '/admissions', {
    actor: human, qr_token: ticket.qr_payload,
  }, [409], { expectedError: 'event_canceled' });
}
async function reportRefunds(a) {
  await configuration(a);
  const f = await fixture(a);
  const partialAmount = Math.floor(f.order.pricing.total.amount / 3);
  const makeRefund = (label, amount) => ({
    attempt_id: f.at.attempt_id,
    connection_id: f.at.connection.connection_id,
    provider_payment_reference: f.body.provider_payment_reference,
    provider_refund_reference: 'fake-refund-' + label + '-' + a.run.id,
    source_reference: 'fake-refund-source-' + label + '-' + a.run.id,
    outcome: 'completed', amount, currency: f.order.pricing.total.currency,
    observed_at: iso(a.run.clock + (label === 'partial' ? 5000 : 6000)),
  });
  const path = '/v1/admin/orders/' + id(f.order.order_id) + '/refund-reports';
  await a.write('partial-refund', path, makeRefund('partial', partialAmount), [201]);
  const partial = await a.read('partial-refund-order', '/v1/admin/orders/' + id(f.order.order_id));
  const ticketAfterPartial = await a.read('ticket-after-partial-refund', '/v1/public/tickets/' + id(f.ticket.ticket_token));
  a.check('partial refund preserves entry', partial.data.refund_status === 'partial' && ticketAfterPartial.data.can_admit === true,
    'A partial completed refund updates money status without revoking the Ticket', { refundStatus: partial.data.refund_status, canAdmit: ticketAfterPartial.data.can_admit });
  await a.write('complete-refund', path, makeRefund('complete', f.order.pricing.total.amount - partialAmount), [201]);
  const full = await a.read('fully-refunded-order', '/v1/admin/orders/' + id(f.order.order_id));
  const buyer = await a.read('buyer-after-full-refund', '/v1/public/orders/' + id(f.order.order_token));
  const wallet = await a.read('wallet-after-full-refund', '/v1/public/tickets/' + id(f.ticket.ticket_token) + '/apple-wallet-data');
  const eventAfter = await a.read('capacity-after-full-refund', '/v1/admin/events/' + id(f.e.event_id));
  a.check('full refund blocks entry and preserves history', full.data.refund_status === 'full'
    && buyer.data.tickets.length === 1 && buyer.data.tickets[0].ticket_id === f.ticket.ticket_id
    && buyer.data.tickets[0].can_admit === false,
  'The issued Ticket and its history remain, but the fully refunded Ticket cannot be admitted', { refundStatus: full.data.refund_status, ticketCount: buyer.data.tickets.length, canAdmit: buyer.data.tickets[0]?.can_admit });
  a.check('full refund voids Wallet data', wallet.data.voided === true,
    'Unsigned Wallet data reflects the current voided state', { voided: wallet.data.voided, data_version: wallet.data.data_version });
  a.check('unadmitted capacity restored', eventAfter.data.ticket_offering.available_quantity === f.e.ticket_offering.available_quantity,
    'A fully refunded unadmitted Ticket restores its capacity once', eventAfter.data.ticket_offering.available_quantity);
  await a.write('admission-after-full-refund', '/v1/admin/events/' + id(f.e.event_id) + '/admissions', {
    actor: human, qr_token: f.ticket.qr_payload,
  }, [409], { expectedError: 'ticket_refunded' });
}
async function eventReporting(a) {
  await configuration(a);
  const f = await fixture(a);
  const ordersPath = '/v1/admin/events/' + id(f.e.event_id) + '/orders?limit=100';
  const ticketsPath = '/v1/admin/events/' + id(f.e.event_id) + '/tickets?limit=100';
  const totalsPath = '/v1/admin/events/' + id(f.e.event_id) + '/totals';
  const orders = await a.read('event-order-list', ordersPath);
  const tickets = await a.read('event-ticket-list', ticketsPath);
  const initial = await a.read('event-totals-pending', totalsPath);
  const initialCurrency = initial.data.sales.find(item => item.currency === f.order.pricing.total.currency);
  a.check('operational lists', orders.data.some(item => item.order_id === f.order.order_id)
    && tickets.data.some(item => item.ticket_id === f.ticket.ticket_id),
  'Site staff can list this Order and Ticket without buyer access tokens', { orders: orders.data.length, tickets: tickets.data.length });
  a.check('fees start pending', initialCurrency?.processing_fees?.reporting_status === 'pending'
    && initialCurrency?.platform_fees?.reporting_status === 'pending',
  'Missing fee evidence is represented as pending, not zero', initialCurrency);
  const paymentReference = f.body.provider_payment_reference;
  const fees = [
    { category: 'processing', amount: 125 },
    { category: 'platform', amount: 250 },
  ];
  for (const fee of fees) {
    await a.write('fee-' + fee.category, '/v1/admin/orders/' + id(f.order.order_id) + '/fee-reports', {
      actor: system, attempt_id: f.at.attempt_id, connection_id: f.at.connection.connection_id,
      scope_type: 'payment', scope_reference: paymentReference,
      source_reference: 'fake-fee-' + fee.category + '-' + a.run.id, source_revision: 1,
      category: fee.category, direction: 'charge', amount: fee.amount,
      currency: f.order.pricing.total.currency, observed_at: iso(a.run.clock + 7000),
    }, [201]);
    await a.write('fee-' + fee.category + '-confirmation', '/v1/admin/orders/' + id(f.order.order_id) + '/fee-confirmations', {
      actor: system, attempt_id: f.at.attempt_id, connection_id: f.at.connection.connection_id,
      scope_type: 'payment', scope_reference: paymentReference, category: fee.category,
      totals: [{ currency: f.order.pricing.total.currency, charged: fee.amount, returned: 0 }],
      observed_at: iso(a.run.clock + 8000),
    });
  }
  const final = await a.read('event-totals-confirmed', totalsPath);
  const currency = final.data.sales.find(item => item.currency === f.order.pricing.total.currency);
  a.check('confirmed fee totals', currency?.processing_fees?.reporting_status === 'complete'
    && currency.processing_fees.charged.amount === 125
    && currency?.platform_fees?.reporting_status === 'complete'
    && currency.platform_fees.charged.amount === 250,
  'Explicit confirmations make both fee categories complete with the reported amounts', currency);
}
async function connectionHistory(a) {
  const active = await configuration(a);
  let e = await event(a, 'connection-history');
  const resourceType = active.provider === 'square' ? 'square_item_variation' : 'stripe_price';
  const originalReference = 'fake-resource-original-' + a.run.id;
  const initial = await a.call('mapping-original', '/v1/admin/events/' + id(e.event_id) + '/provider-mappings/' + id(active.connection_id), {
    method: 'PUT', body: { actor: human, resource_type: resourceType, resource_reference: originalReference, verified_at: iso(a.run.clock), expected_version: e.version },
  });
  e = initial.data;
  const { order } = await reserve(a, e, 'mapped-purchase');
  const at = await attempt(a, order, 'mapped-attempt');
  a.check('attempt freezes mapping', at.provider_mapping?.resource_reference === originalReference,
    'The payment attempt copies the Order mapping snapshot', at.provider_mapping);
  const replacementReference = 'fake-resource-replacement-' + a.run.id;
  const beforeEdit = await a.read('mapping-event-before-replacement', '/v1/admin/events/' + id(e.event_id));
  await a.call('mapping-replacement', '/v1/admin/events/' + id(e.event_id) + '/provider-mappings/' + id(active.connection_id), {
    method: 'PUT', body: { actor: human, resource_type: resourceType, resource_reference: replacementReference, verified_at: iso(a.run.clock + 1000), expected_version: beforeEdit.data.version },
  });
  const existingOrder = await a.read('existing-mapped-order', '/v1/admin/orders/' + id(order.order_id));
  const existingAttempt = await a.read('existing-mapped-attempt', '/v1/admin/payment-attempts/' + id(at.attempt_id));
  a.check('history retains old mapping', existingOrder.data.payment_attempts[0]?.provider_mapping?.resource_reference === originalReference
    && existingAttempt.data.provider_mapping?.resource_reference === originalReference,
  'Existing Order and attempt retain their original provider mapping', { order: existingOrder.data.payment_attempts[0]?.provider_mapping, attempt: existingAttempt.data.provider_mapping });
  const { order: nextOrder } = await reserve(a, e, 'replacement-mapped-purchase');
  const nextAttempt = await attempt(a, nextOrder, 'replacement-mapped-attempt');
  a.check('future Order uses new mapping', nextAttempt.provider_mapping?.resource_reference === replacementReference,
    'New purchases use the Event mapping currently assigned to the connection', nextAttempt.provider_mapping);
}
async function privateApproval(a) {
  await configuration(a);
  const e = await event(a, 'private-approval', { visibility: 'private' });
  const attendee = { name: 'Fake LMNL Attendee ' + a.run.id.slice(0, 8), email: 'attendee-' + a.run.id.slice(0, 8) + '@fake-lmnl.test' };
  const eventPath = '/v1/admin/events/' + id(e.event_id);
  const before = await a.read('private-capacity-before', eventPath);
  await a.write('private-request-one', '/v1/public/events/' + id(e.event_id) + '/access-requests', attendee, [201]);
  const firstList = await a.read('private-request-list-one', eventPath + '/access-requests?limit=100');
  const first = firstList.data.find(item => item.status === 'pending' && item.email === attendee.email);
  if (!first) throw new Blocked('The first private attendee request is not visible to the Site.');
  const approved = await a.write('private-approve-one', '/v1/admin/access-requests/' + id(first.request_id) + '/actions/approve', {
    actor: human, expected_version: first.version,
  });
  const firstJobs = await a.read('private-approval-jobs-one', '/v1/admin/notification-jobs?event_id=' + id(e.event_id) + '&kind=access_approved&limit=100');
  const firstJob = firstJobs.data.find(item => item.access_request_id === first.request_id && !item.is_superseded);
  const oldToken = firstJob?.payload?.approval_token;
  if (!oldToken) throw new Blocked('The approved request has no current approval-link job.');
  await a.write('private-request-two', '/v1/public/events/' + id(e.event_id) + '/access-requests', attendee, [201]);
  const secondList = await a.read('private-request-list-two', eventPath + '/access-requests?limit=100');
  const second = secondList.data.find(item => item.request_id !== first.request_id && item.status === 'pending' && item.email === attendee.email);
  if (!second) throw new Blocked('An intentional duplicate attendee request did not create its own request record.');
  const rejected = await a.write('private-reject-two', '/v1/admin/access-requests/' + id(second.request_id) + '/actions/reject', {
    actor: human, expected_version: second.version,
  });
  const afterRejectJobs = await a.read('private-jobs-after-reject', '/v1/admin/notification-jobs?event_id=' + id(e.event_id) + '&kind=access_approved&limit=100');
  a.check('rejection sends no approval job', !afterRejectJobs.data.some(item => item.access_request_id === second.request_id),
    'Rejecting a request queues no approval email', afterRejectJobs.data.map(item => item.access_request_id));
  const afterRequests = await a.read('private-capacity-after', eventPath);
  a.check('requests do not reserve capacity', afterRequests.data.ticket_offering.available_quantity === before.data.ticket_offering.available_quantity,
    'Submitting and deciding Access Requests do not reserve Ticket capacity', afterRequests.data.ticket_offering.available_quantity);
  const undone = await a.write('private-undo-one', '/v1/admin/access-requests/' + id(first.request_id) + '/actions/undo_decision', {
    actor: human, expected_version: approved.data.version,
  });
  await a.read('old-approval-invalidated', '/v1/public/access-requests/' + id(oldToken), { expected: [404], expectedError: 'not_found' });
  await a.write('private-reapprove-one', '/v1/admin/access-requests/' + id(first.request_id) + '/actions/approve', {
    actor: human, expected_version: undone.data.version,
  });
  const renewedJobs = await a.read('private-renewed-approval-jobs', '/v1/admin/notification-jobs?event_id=' + id(e.event_id) + '&kind=access_approved&limit=100');
  const renewedJob = renewedJobs.data.find(item => item.access_request_id === first.request_id
    && !item.is_superseded && item.payload?.approval_token !== oldToken);
  if (!renewedJob?.payload?.approval_token) throw new Blocked('Reapproval did not create a replacement approval link.');
  const renewed = await a.read('renewed-approval-link', '/v1/public/access-requests/' + id(renewedJob.payload.approval_token));
  a.check('renewed approval link works', renewed.data.request_id === first.request_id && renewed.data.purchase_completed === false,
    'A renewed approval has a new valid link and no purchase yet', renewed.data);
  a.check('duplicate request identity preserved', rejected.data.request_id === second.request_id && rejected.data.status === 'rejected',
    'An identical attendee may have a separate independently rejected request', { request_id: rejected.data.request_id, status: rejected.data.status });
}
async function privatePurchase(a) {
  await configuration(a);
  const approved = await createApprovedPrivateRequest(a, 'private-purchase');
  const quote = await a.write('private-quote', '/v1/public/events/' + id(approved.e.event_id) + '/quotes', {
    quantity: 1, access_request_token: approved.token,
  }, [201]);
  const buyer = { name: 'Fake LMNL Purchaser', email: 'payer-' + a.run.id.slice(0, 8) + '@fake-lmnl.test' };
  const orderResult = await a.write('private-order', '/v1/public/orders', {
    quote_id: quote.data.quote_id, access_request_token: approved.token, buyer,
  }, [201]);
  const order = orderResult.data;
  a.check('private purchaser and attendee differ', order.payment_status === 'unpaid' && order.tickets.length === 0
    && order.buyer_name === buyer.name,
  'Private checkout records purchaser details separately from the approved attendee', { status: order.payment_status, buyer: order.buyer_name, tickets: order.tickets.length });
  const attemptResult = await attempt(a, order, 'private-attempt');
  const reference = await checkout(a, attemptResult);
  const { ticket } = await paid(a, order, attemptResult, reference);
  const admin = await a.read('private-admin-order', '/v1/admin/orders/' + id(order.order_id));
  a.check('Ticket keeps approved attendee', ticket.attendee_name === approved.attendee.name
    && admin.data.approved_attendee?.name === approved.attendee.name
    && admin.data.approved_attendee?.email === approved.attendee.email
    && admin.data.checkout_identity?.email === buyer.email,
  'The issued Ticket retains the approved attendee while the Order retains the separate purchaser', {
    ticketAttendee: ticket.attendee_name, approvedAttendee: admin.data.approved_attendee, purchaser: admin.data.checkout_identity,
  });
  const completed = await a.read('private-approval-consumed', '/v1/public/access-requests/' + id(approved.token));
  a.check('approval consumed after purchase', completed.data.purchase_completed === true,
    'A successful paid Order consumes this approval', { purchaseCompleted: completed.data.purchase_completed });
  await a.write('second-private-purchase-blocked', '/v1/public/events/' + id(approved.e.event_id) + '/quotes', {
    quantity: 1, access_request_token: approved.token,
  }, [409], { expectedError: 'access_already_used' });
}
async function walletData(a) {
  await configuration(a);
  const f = await fixture(a);
  const publicPath = '/v1/public/tickets/' + id(f.ticket.ticket_token) + '/apple-wallet-data';
  const adminPath = '/v1/admin/tickets/' + id(f.ticket.ticket_id) + '/apple-wallet-data';
  const initialPublic = await a.read('wallet-public-data', publicPath);
  const initialAdmin = await a.read('wallet-admin-data', adminPath);
  a.check('public and admin Wallet data agree', initialPublic.data.ticket_id === f.ticket.ticket_id
    && initialPublic.data.qr_payload === f.ticket.qr_payload
    && initialPublic.data.data_version === initialAdmin.data.data_version
    && initialPublic.data.used === false && initialPublic.data.voided === false,
  'Buyer-token and Site-admin reads return the same unsigned current Ticket data', { publicVersion: initialPublic.data.data_version, adminVersion: initialAdmin.data.data_version, used: initialPublic.data.used, voided: initialPublic.data.voided });
  a.check('public Wallet data omits purchaser email', !JSON.stringify(initialPublic.data).includes(f.order.delivery_email)
    && !Object.hasOwn(initialPublic.data, 'buyer_email') && !Object.hasOwn(initialPublic.data, 'delivery_email'),
  'The buyer Wallet-data route does not expose purchaser email', initialPublic.data);
  await a.write('wallet-admission', '/v1/admin/events/' + id(f.e.event_id) + '/admissions', { actor: human, qr_token: f.ticket.qr_payload }, [201]);
  const after = await a.read('wallet-after-admission', publicPath, { fresh: true });
  a.check('Wallet data reflects Admission', after.data.used === true && after.data.voided === false
    && after.data.qr_payload === initialPublic.data.qr_payload
    && after.data.data_version !== initialPublic.data.data_version,
  'Admission changes the Wallet data version and used state without changing the stable QR', { used: after.data.used, voided: after.data.voided, sameQr: after.data.qr_payload === initialPublic.data.qr_payload, versionChanged: after.data.data_version !== initialPublic.data.data_version });
}
async function walletUpdateJobs(a) {
  await configuration(a);
  const f = await fixture(a);
  await a.write('wallet-update-admission', '/v1/admin/events/' + id(f.e.event_id) + '/admissions', { actor: human, qr_token: f.ticket.qr_payload }, [201]);
  const used = await a.read('wallet-update-used-data', '/v1/public/tickets/' + id(f.ticket.ticket_token) + '/apple-wallet-data');
  const initialJobs = await a.read('wallet-update-after-admission', '/v1/admin/notification-jobs?kind=wallet_update&limit=100');
  const admissionJob = initialJobs.data.find(item => item.ticket_id === f.ticket.ticket_id && !item.is_superseded);
  a.check('Admission queues Wallet update', Boolean(admissionJob) && admissionJob.payload?.data_version === used.data.data_version,
    'A durable Wallet job identifies the current used-state data version', admissionJob?.payload);
  const before = await a.read('wallet-update-event-before', '/v1/admin/events/' + id(f.e.event_id));
  await a.call('wallet-update-event-edit', '/v1/admin/events/' + id(f.e.event_id), {
    method: 'PATCH',
    body: { actor: human, expected_version: before.data.version, venue: { name: 'Fake LMNL Wallet update venue' } },
  });
  const current = await a.read('wallet-update-current-data', '/v1/admin/tickets/' + id(f.ticket.ticket_id) + '/apple-wallet-data');
  const eventJobs = await a.read('wallet-update-after-event-change', '/v1/admin/notification-jobs?kind=wallet_update&limit=100');
  const currentJob = eventJobs.data.find(item => item.ticket_id === f.ticket.ticket_id
    && item.payload?.data_version === current.data.data_version && !item.is_superseded);
  a.check('Event edit queues current Wallet version', Boolean(currentJob) && current.data.data_version !== used.data.data_version,
    'Event operational changes queue the updated unsigned data version for the same Ticket', { currentVersion: current.data.data_version, queued: currentJob?.payload });
}
async function groupPurchase(a) {
  await configuration(a);
  const e = await event(a, 'group-purchase', { capacity: 8 });
  const eventPath = '/v1/admin/events/' + id(e.event_id);
  const before = await a.read('group-capacity-before-quote', eventPath);
  const quote = await a.write('group-quote', '/v1/public/events/' + id(e.event_id) + '/quotes', { quantity: 3 }, [201]);
  const afterQuote = await a.read('group-capacity-after-quote', eventPath);
  a.check('group quote does not reserve', quote.data.quantity === 3
    && afterQuote.data.ticket_offering.available_quantity === before.data.ticket_offering.available_quantity,
  'A three-Ticket quote preserves its quantity without reserving capacity', { quoteQuantity: quote.data.quantity, availableBefore: before.data.ticket_offering.available_quantity, availableAfter: afterQuote.data.ticket_offering.available_quantity });
  a.check('group quote pricing scales', quote.data.subtotal.amount === quote.data.unit_price.amount * 3,
    'The quote subtotal is the unit price multiplied by the requested quantity', { unitPrice: quote.data.unit_price, subtotal: quote.data.subtotal });
  const buyer = { name: 'Fake LMNL Group Buyer', email: 'group-' + a.run.id.slice(0, 8) + '@fake-lmnl.test' };
  const created = await a.write('group-order', '/v1/public/orders', { quote_id: quote.data.quote_id, buyer }, [201]);
  const order = created.data;
  a.check('group Order and Reservation', order.quantity === 3 && order.reservation?.quantity === 3
    && order.reservation?.status === 'held' && order.tickets.length === 0
    && order.pricing.total.amount === quote.data.total.amount,
  'One unpaid Order holds all three Tickets at the accepted full quote total', { quantity: order.quantity, reservation: order.reservation, total: order.pricing.total, tickets: order.tickets.length });
  const afterOrder = await a.read('group-capacity-after-order', eventPath);
  a.check('group Reservation capacity', afterOrder.data.ticket_offering.available_quantity === before.data.ticket_offering.available_quantity - 3,
    'Order creation reserves the full requested quantity atomically', { availableBefore: before.data.ticket_offering.available_quantity, availableAfter: afterOrder.data.ticket_offering.available_quantity });
  const at = await attempt(a, order, 'group-attempt');
  const reference = await checkout(a, at);
  const { tickets } = await paid(a, order, at, reference);
  const f = { e, order, at, reference, ticket: tickets[0], tickets };
  await deliver(a, f);
  const orderPage = await a.read('group-order-page', '/v1/public/orders/' + id(order.order_token), { fresh: true });
  a.check('Order page presents complete group', orderPage.data.quantity === 3
    && orderPage.data.tickets.length === 3
    && orderPage.data.tickets.map(item => item.ticket_id).join('|') === tickets.map(item => item.ticket_id).join('|'),
  'The Order page presents all three issued Tickets in stable order', { quantity: orderPage.data.quantity, ticketIds: orderPage.data.tickets.map(item => item.ticket_id) });
  const ticketPages = [];
  for (const ticket of tickets) {
    const page = await a.read('group-ticket-page-' + ticket.ordinal, '/v1/public/tickets/' + id(ticket.ticket_token));
    ticketPages.push(page.data);
  }
  a.check('independent Ticket pages', ticketPages.length === 3
    && ticketPages.every((page, index) => page.ticket_id === tickets[index].ticket_id && page.ordinal === index + 1 && page.qr_payload === tickets[index].qr_payload),
  'Each group member has a separate page, Ticket identity, ordinal, and QR', ticketPages.map(page => ({ ticket_id: page.ticket_id, ordinal: page.ordinal })));
  const staffLookup = await a.write('group-staff-lookup', eventPath + '/ticket-lookup', { order_reference: order.order_reference });
  a.check('staff lookup shows complete group', staffLookup.data.length === 1
    && staffLookup.data[0].tickets.length === 3
    && staffLookup.data[0].tickets.map(item => item.ticket_id).join('|') === tickets.map(item => item.ticket_id).join('|')
    && !/order_token|ticket_token|qr_payload|qr_token/.test(JSON.stringify(staffLookup.envelope)),
  'Staff lookup finds the Order and all Tickets without exposing buyer access tokens or QR data', staffLookup.data);
  const staffTickets = await a.read('group-event-ticket-list', eventPath + '/tickets?limit=100');
  a.check('Event list includes group Tickets', tickets.every(ticket => staffTickets.data.some(item => item.ticket_id === ticket.ticket_id)),
    'Event Ticket reporting includes every Ticket from the Order', staffTickets.data.map(item => item.ticket_id));
  for (const ticket of tickets) {
    const path = eventPath + '/admissions';
    const body = { actor: human, qr_token: ticket.qr_payload };
    const admission = await a.write('group-admission-' + ticket.ordinal, path, body, [201]);
    const page = await a.read('group-admitted-page-' + ticket.ordinal, '/v1/public/tickets/' + id(ticket.ticket_token), { fresh: true });
    a.check('group Ticket admitted once ' + ticket.ordinal, page.data.admission_status === 'admitted'
      && page.data.can_admit === false && admission.data.ticket_id === ticket.ticket_id,
    'Each Ticket can be admitted independently once', { ordinal: ticket.ordinal, status: page.data.admission_status, canAdmit: page.data.can_admit });
    await a.write('group-repeat-admission-' + ticket.ordinal, path, body, [409], { expectedError: 'already_admitted' });
  }
}

export async function execute(a) {
  const workflow = a.run.workflow;
  if (workflow === 'service') { await configuration(a); return; }
  if (workflow === 'checkout' || workflow === 'closure') { await closure(a); return; }
  if (workflow === 'recovery-frontier') { await recoveryFrontier(a); return; }
  if (workflow === 'arrival-change') { await arrivalChange(a); return; }
  if (workflow === 'cancellation') { await cancelEvent(a); return; }
  if (workflow === 'refund') { await reportRefunds(a); return; }
  if (workflow === 'reporting') { await eventReporting(a); return; }
  if (workflow === 'connection-history') { await connectionHistory(a); return; }
  if (workflow === 'private-approval') { await privateApproval(a); return; }
  if (workflow === 'private-purchase') { await privatePurchase(a); return; }
  if (workflow === 'wallet-data') { await walletData(a); return; }
  if (workflow === 'wallet-updates') { await walletUpdateJobs(a); return; }
  if (workflow === 'group-purchase') { await groupPurchase(a); return; }
  if (workflow === 'configuration') {
    await configuration(a); await a.read('missing-key', '/v1/admin/payment-configuration', { auth: 'none', expected: [401], expectedError: 'unauthorized' });
    const otherConfig = await a.read('other-Site-configuration', '/v1/admin/payment-configuration', { auth: 'other' });
    a.check('shared test connection', otherConfig.data?.active_connection?.connection_id === a.config.connectionId, 'Both dedicated Sites must share the test connection; assign it to the secondary Site with the operator CLI', otherConfig.data?.active_connection?.connection_id);
    await a.read('other-Site-shared-connection', `/v1/admin/payment-connections/${id(a.config.connectionId)}`, { auth: 'other' });
    const f = await fixture(a);
    const denied = {
      event: `/v1/admin/events/${id(f.e.event_id)}`, 'public-event': `/v1/public/events/${id(f.e.event_id)}`,
      'payment-status': `/v1/admin/orders/${id(f.order.order_id)}/payment-status`, attempt: `/v1/admin/payment-attempts/${id(f.at.attempt_id)}`,
      'order-token': `/v1/public/orders/${id(f.order.order_token)}`, 'ticket-token': `/v1/public/tickets/${id(f.ticket.ticket_token)}`,
    };
    for (const [name, path] of Object.entries(denied)) await a.read('other-Site-' + name, path, { auth: 'other', expected: [404], expectedError: 'not_found' });
    const otherEvent = await event(a, 'other-event', { auth: 'other' }), { order } = await reserve(a, otherEvent, 'other-purchase', 'other'), at = await attempt(a, order, 'other-attempt', 'other');
    await a.write('other-Site-provider-reference', `/v1/admin/payment-attempts/${id(at.attempt_id)}/checkout-reference`, { actor: system, connection_id: a.config.connectionId, provider_checkout_reference: f.reference, provider_can_take_payment: true }, [404], { auth: 'other', expectedError: 'not_found' });
    return;
  }
  if (workflow === 'events') {
    await configuration(a);
    const draft = await a.write('draft-only', '/v1/admin/events', { actor: human }, [201]);
    const replay = await a.write('draft-replay', '/v1/admin/events', { actor: human }, [201], { key: a.run.journal['draft-only'].key });
    a.check('draft replay', replay.data.event_id === draft.data.event_id, 'Original key preserves Event identity', replay.data.event_id);
    await a.read('draft-hidden', `/v1/public/events/${id(draft.data.event_id)}`, { expected: [404], expectedError: 'not_found' });
    const e = await event(a); await a.read('staff-events', '/v1/admin/events?limit=100'); await a.read('public-current', '/v1/public/events?period=current&limit=100'); await a.read('published-detail', `/v1/public/events/${id(e.event_id)}`);
    const ended = await event(a, 'ended', { ended: true }); await a.write('archive', `/v1/admin/events/${id(ended.event_id)}/actions/archive`, { actor: human, expected_version: ended.version });
    await a.read('public-past', '/v1/public/events?period=past&limit=100'); const archived = await a.read('archived-detail', `/v1/public/events/${id(ended.event_id)}`);
    a.check('archived retrieval', archived.data.event_id === ended.event_id, 'Archived Event remains readable', archived.data.event_id); return;
  }
  if (workflow === 'sales' || workflow === 'reservation') {
    await configuration(a); let e = await event(a, 'event', { capacity: 2 }); const p = `/v1/admin/events/${id(e.event_id)}`;
    if (workflow === 'sales') {
      e = (await a.write('stop-sales', p + '/actions/stop_sales', { actor: human, expected_version: e.version })).data;
      const stopped = await a.read('stopped-public', `/v1/public/events/${id(e.event_id)}`); a.check('authoritative paused', stopped.data.sales_status === 'paused', 'Public sales status is paused', stopped.data.sales_status);
      e = (await a.write('resume-sales', p + '/actions/resume_sales', { actor: human, expected_version: e.version })).data;
    }
    const before = await a.read('before-quote', p), { order, quote } = await reserve(a, e), key = a.run.journal['purchase-order'].key, buyer = { name: 'Fake LMNL Buyer', email: 'buyer@fake-lmnl.test' };
    const replay = await a.write('order-replay', '/v1/public/orders', { quote_id: quote.quote_id, buyer }, [201], { key }); a.check('one replayed Order', replay.data.order_id === order.order_id, 'Original key preserves Order identity', replay.data.order_id);
    if (workflow === 'sales') {
      const capacityFloor = await a.call('capacity-floor', p, {
        method: 'PATCH',
        body: { actor: human, expected_version: e.version, ticket_offering: { capacity: 0 } },
        expected: [422],
        expectedError: 'validation_failed',
      });
      a.check(
        'capacity-floor rule',
        capacityFloor.error?.details?.some(detail => detail.code === 'below_committed_capacity'),
        'Validation details include below_committed_capacity',
        capacityFloor.error?.details,
      );
      await a.call('price-edit', p, { method: 'PATCH', body: { actor: human, expected_version: e.version, ticket_offering: { price: { amount: 3000, currency: 'USD' } } } });
      const frozen = await a.read('frozen-order', `/v1/public/orders/${id(order.order_token)}`); a.check('immutable accepted price', frozen.data.pricing.total.amount === order.pricing.total.amount, 'Event edit preserves accepted Order total', frozen.data.pricing.total);
    } else {
      await a.write('used-quote', '/v1/public/orders', { quote_id: quote.quote_id, buyer }, [409], { expectedError: 'quote_already_used' });
      await a.write('conflicting-key', '/v1/public/orders', { quote_id: quote.quote_id, buyer: { ...buyer, name: 'Different Buyer' } }, [409], { key, expectedError: 'idempotency_conflict' });
      const q1 = await a.write('race-quote-one', `/v1/public/events/${id(e.event_id)}/quotes`, { quantity: 1 }, [201]), q2 = await a.write('race-quote-two', `/v1/public/events/${id(e.event_id)}/quotes`, { quantity: 1 }, [201]);
      const afterQuote = await a.read('after-quotes', p); a.check('quotes do not reserve', before.data.ticket_offering.available_quantity - 1 === afterQuote.data.ticket_offering.available_quantity, 'Only created Order reserved capacity', afterQuote.data.ticket_offering.available_quantity);
      const race = await settleRequests([q1, q2].map((q, i) => a.write('race-order-' + i, '/v1/public/orders', { quote_id: q.data.quote_id, buyer }, [201, 409])));
      a.check('last-capacity race', race.filter(r => r.status === 201).length === 1 && race.some(r => r.error?.code === 'sold_out'), 'One Order succeeds and one is sold_out', race.map(r => ({ status: r.status, error: r.error?.code })));
    } return;
  }
  if (workflow === 'conflict') {
    await configuration(a);
    const e = await event(a, 'conflict-event');
    const { order } = await reserve(a, e, 'conflict-purchase');
    const at = await attempt(a, order, 'conflict-attempt');
    const reference = await checkout(a, at);
    const conflicting = {
      connection_id: at.connection.connection_id,
      source_reference: `fake-conflict-${a.run.id}`,
      provider_checkout_reference: reference,
      provider_payment_reference: `fake-payment-${a.run.id}`,
      outcome: 'paid',
      observed_at: iso(a.run.clock + 1000),
      payment_started_at: iso(a.run.clock + 500),
      provider_can_take_payment: false,
      amount: at.total.amount + 1,
      currency: at.total.currency,
    };
    await a.write('conflicting-payment', `/v1/admin/payment-attempts/${id(at.attempt_id)}/payment-reports`, conflicting, [409], { expectedError: 'payment_report_conflict' });
    const blocked = await a.read('conflicted-order', `/v1/public/orders/${id(order.order_token)}`);
    a.check('conflict blocks fulfillment', blocked.data.payment_status === 'conflicted' && blocked.data.tickets.length === 0,
      'A conflicting payment remains unresolved without issuing a Ticket', { payment: blocked.data.payment_status, tickets: blocked.data.tickets.length });
    const frontier = await a.read('conflict-frontier', '/v1/admin/payment-attempts?requires_verification=true&limit=100');
    a.check('conflict frontier', frontier.data.some(item => item.attempt_id === at.attempt_id && item.requires_verification),
      'Staff can find the conflicted attempt in the verification frontier', frontier.data.map(item => item.attempt_id));
    const detail = await a.read('conflict-investigation', `/v1/admin/payment-attempts/${id(at.attempt_id)}`);
    a.check('conflict investigation', detail.data.issues.some(issue => issue.status === 'open' && issue.code === 'payment_report_conflict')
      && detail.data.reports.some(report => report.source_reference === conflicting.source_reference && report.conflict_code === 'payment_report_conflict'),
    'Attempt detail retains the conflicting report and open issue', { issues: detail.data.issues.length, reports: detail.data.reports.length });
    const resolutionBase = {
      actor: human,
      reason: 'Operator verified the provider payment against the recorded checkout.',
      verification_reference: `ref:fake-payment-verification-${a.run.id}`,
      report: {
        connection_id: at.connection.connection_id,
        source_reference: `fake-resolution-${a.run.id}`,
        provider_checkout_reference: reference,
        provider_payment_reference: `fake-resolved-payment-${a.run.id}`,
        outcome: 'paid',
        observed_at: iso(a.run.clock + 2000),
        payment_started_at: iso(a.run.clock + 500),
        provider_can_take_payment: false,
        amount: at.total.amount,
        currency: at.total.currency,
      },
    };
    await a.write('stale-resolution', `/v1/admin/payment-attempts/${id(at.attempt_id)}/actions/resolve`,
      { ...resolutionBase, expected_version: detail.data.version - 1 }, [409], { expectedError: 'version_conflict' });
    await a.write('invalid-resolution', `/v1/admin/payment-attempts/${id(at.attempt_id)}/actions/resolve`,
      { ...resolutionBase, expected_version: detail.data.version, report: { ...resolutionBase.report, source_reference: `fake-invalid-resolution-${a.run.id}`, amount: at.total.amount + 2 } },
      [409], { expectedError: 'payment_report_conflict' });
    const afterInvalid = await a.read('after-invalid-resolution', `/v1/admin/payment-attempts/${id(at.attempt_id)}`);
    const resolved = await a.write('resolve-payment', `/v1/admin/payment-attempts/${id(at.attempt_id)}/actions/resolve`,
      { ...resolutionBase, expected_version: afterInvalid.data.version }, [200]);
    a.check('guarded resolution', resolved.data.applied === true && resolved.data.resolved_issue_ids.length >= 1,
      'A valid verified report resolves the retained conflict', resolved.data.resolved_issue_ids);
    await a.write('resolve-payment-replay', `/v1/admin/payment-attempts/${id(at.attempt_id)}/actions/resolve`,
      { ...resolutionBase, expected_version: afterInvalid.data.version }, [200], { key: a.run.journal['resolve-payment'].key });
    const issued = await a.read('resolved-order', `/v1/public/orders/${id(order.order_token)}`, { fresh: true });
    a.check('resolved issuance', issued.data.payment_status === 'paid' && issued.data.issuance_status === 'issued' && issued.data.tickets.length === 1,
      'Guarded resolution permits one complete Ticket issuance', { payment: issued.data.payment_status, issuance: issued.data.issuance_status, tickets: issued.data.tickets.length });
    const resolvedReportFrontier = await a.read('resolved-report-frontier', '/v1/admin/payment-attempts?requires_report_work=true&limit=100');
    a.check('resolved conflict is not requeued', !resolvedReportFrontier.data.some(item => item.attempt_id === at.attempt_id),
      'A valid paid resolution excludes resolved historical conflicts from report work', resolvedReportFrontier.data.map(item => item.attempt_id));
    const delayed = await a.write('delayed-failed-report', `/v1/admin/payment-attempts/${id(at.attempt_id)}/payment-reports`, {
      connection_id: at.connection.connection_id,
      source_reference: `fake-delayed-failed-${a.run.id}`,
      provider_checkout_reference: reference,
      provider_payment_reference: null,
      outcome: 'failed',
      observed_at: iso(a.run.clock + 1500),
      payment_started_at: null,
      provider_can_take_payment: false,
    }, [201]);
    a.check('delayed evidence is stale', delayed.data.applied === false, 'Older failed evidence is retained without regressing paid state', delayed.data.applied);
    const delayedReportFrontier = await a.read('delayed-report-frontier', '/v1/admin/payment-attempts?requires_report_work=true&limit=100');
    a.check('delayed report is discoverable', delayedReportFrontier.data.some(item => item.attempt_id === at.attempt_id && item.requires_report_work === true),
      'An unapplied delayed report is visible through the report-work frontier', delayedReportFrontier.data.map(item => item.attempt_id));
    const final = await a.read('after-delayed-evidence', `/v1/public/orders/${id(order.order_token)}`, { fresh: true });
    a.check('paid state remains authoritative', final.data.payment_status === 'paid' && final.data.tickets.length === 1,
      'Delayed evidence does not create a second Ticket or undo payment', { payment: final.data.payment_status, tickets: final.data.tickets.length });
    return;
  }
  const f = await fixture(a, workflow === 'delivery-correction'
    ? { buyerEmail: `buyer-39-${a.run.id.slice(0, 8)}@example.test` }
    : {});
  if (workflow === 'issuance-recovery') {
    const staff = await a.read('staff-order-recovery', `/v1/admin/orders/${id(f.order.order_id)}`, { fresh: true });
    a.check('staff Order recovery view', staff.data.payment_status === 'paid'
      && staff.data.issuance_status === 'issued'
      && staff.data.tickets.length === 1
      && staff.data.notification_jobs.filter(job => job.kind === 'tickets_ready').length === 1,
    'Staff Order view retains one Ticket and one initial delivery job', {
      payment: staff.data.payment_status,
      issuance: staff.data.issuance_status,
      tickets: staff.data.tickets.length,
      jobs: staff.data.notification_jobs.length,
    });
    const scheduled = await a.scheduler('issuance-recovery-scheduler');
    a.check('scheduler does not duplicate completed Order', scheduled.data.ticket_issuance?.checked >= 0,
      'The bounded scheduler can run without visitor traffic and leaves the completed Order unchanged', scheduled.data.ticket_issuance);
    await a.write('retry-issued-order', `/v1/admin/orders/${id(f.order.order_id)}/actions/retry_ticket_issuance`, {
      actor: human, expected_version: staff.data.version,
    }, [409], { expectedError: 'invalid_state' });
    const after = await a.read('staff-order-after-retry', `/v1/admin/orders/${id(f.order.order_id)}`, { fresh: true });
    a.check('retry remains idempotent', after.data.tickets.length === 1
      && after.data.notification_jobs.filter(job => job.kind === 'tickets_ready').length === 1,
    'A guarded retry cannot duplicate Ticket identities or initial delivery work', {
      tickets: after.data.tickets.length,
      jobs: after.data.notification_jobs.length,
    });
    return;
  }
  if (workflow === 'delivery-recovery') { await deliveryRecovery(a, f); return; }
  if (workflow === 'delivery-correction') { await deliveryRecovery(a, f, { issue39: true }); return; }
  if (['delivery', 'durable-jobs', 'unknown-email', 'journey'].includes(workflow)) await deliver(a, f, { unknown: workflow === 'unknown-email', overlap: workflow === 'durable-jobs' });
  if (workflow === 'durable-jobs') await a.scheduler('bounded-scheduler');
  if (['admission', 'journey'].includes(workflow)) await admit(a, f, { concurrency: workflow === 'admission' });
}
