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
async function event(a, prefix = 'event', { ended = false, capacity = 8, futureCheckIn = false, auth = 'primary' } = {}) {
  const t = a.run.clock, start = ended ? t - 7_200_000 : t + 300_000, end = ended ? t - 3_600_000 : t + 86_400_000;
  const draft = await a.write(prefix + '-draft', '/v1/admin/events', { actor: human }, [201], { auth });
  const p = `/v1/admin/events/${id(draft.data.event_id)}`;
  const saved = await a.call(prefix + '-save', p, { method: 'PATCH', auth, body: {
    actor: human, expected_version: draft.data.version, title: `Fake LMNL ${a.run.id.slice(0, 8)} ${prefix}`, description: 'Dedicated local synthetic workflow Event.', visibility: 'public',
    venue: { name: 'Fake LMNL local venue', address: null }, starts_at: iso(start), ends_at: iso(end), time_zone: 'UTC', check_in_opens_at: futureCheckIn ? iso(start) : iso(start - 600_000),
    ticket_offering: { price: { amount: 2500, currency: 'USD' }, tax_amount: 0, buyer_fees: [], capacity, sales_opens_at: iso(start - 600_000), sales_closes_at: iso(end) },
  } });
  const published = await a.write(prefix + '-publish', p + '/actions/publish', { actor: human, expected_version: saved.data.version }, [200], { auth });
  if (auth === 'primary') a.run.privateContext.event = published.data;
  await a.save(); return published.data;
}
async function reserve(a, e, prefix = 'purchase', auth = 'primary') {
  const quote = await a.write(prefix + '-quote', `/v1/public/events/${id(e.event_id)}/quotes`, { quantity: 1 }, [201], { auth });
  const order = await a.write(prefix + '-order', '/v1/public/orders', { quote_id: quote.data.quote_id, buyer: { name: 'Fake LMNL Buyer', email: a.run.profile === 'sandbox' ? a.config.operatorEmail : 'buyer@fake-lmnl.test' } }, [201], { auth });
  a.check(prefix + ': unpaid Order', order.data.payment_status === 'unpaid' && order.data.tickets.length === 0, 'Unpaid Order with no Tickets', { payment: order.data.payment_status, tickets: order.data.tickets.length });
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
  a.check('complete issuance', buyer.data.payment_status === 'paid' && buyer.data.issuance_status === 'issued' && buyer.data.tickets.length === 1, 'Paid Order has exactly one fully issued Ticket', { payment: buyer.data.payment_status, issuance: buyer.data.issuance_status, tickets: buyer.data.tickets.length });
  const ticket = buyer.data.tickets[0];
  a.check('distinct access scopes', ticket.ticket_token !== order.order_token && ticket.ticket_token !== ticket.qr_payload && !ticket.qr_payload.includes('@'), 'Order token, Ticket token and QR are distinct; QR has no email', { distinct: true });
  await a.read('buyer-ticket', `/v1/public/tickets/${id(ticket.ticket_token)}`);
  await a.read('staff-payment-status', `/v1/admin/orders/${id(order.order_id)}/payment-status`);
  await a.write('paid-report-duplicate-source', `/v1/admin/payment-attempts/${id(at.attempt_id)}/payment-reports`, body, [200]);
  const duplicate = await a.read('after-payment-replay', `/v1/public/orders/${id(order.order_token)}`, { fresh: true });
  a.check('no duplicate Ticket', duplicate.data.tickets.length === 1 && duplicate.data.tickets[0].ticket_id === ticket.ticket_id, 'Repeated report preserves the same Ticket', duplicate.data.tickets.map(t => t.ticket_id));
  a.run.privateContext.ticket = ticket; await a.save(); return { ticket, body };
}
async function fixture(a) {
  await configuration(a); const e = await event(a), { order } = await reserve(a, e), at = await attempt(a, order), reference = await checkout(a, at), payment = await paid(a, order, at, reference);
  return { e, order, at, reference, ...payment };
}
async function deliver(a, f, { unknown = false, overlap = false } = {}) {
  const jobs = await a.read('email-list', `/v1/admin/notification-jobs?order_id=${id(f.order.order_id)}&kind=tickets_ready`);
  const job = jobs.data.find(j => j.order_id === f.order.order_id && j.kind === 'tickets_ready');
  a.check('initial email job', jobs.data.length === 1 && Boolean(job), 'Exactly one initial email job for this Order', jobs.data.length);
  const frontier = await a.read('email-frontier', '/v1/admin/notification-jobs?kind=tickets_ready&limit=100');
  if (frontier.envelope.pagination?.next_cursor) throw new Blocked('The worker frontier exceeds this bounded 100-job run. Resolve preceding work first.');
  if (frontier.data.some(j => j.status !== 'completed' && j.requires_verification)) throw new Blocked('Unfinished jobs require dispatch verification. Resolve their saved runs first; no blind resend is permitted.');
  if (a.run.profile === 'sandbox' && frontier.data.some(j => j.job_id !== job.job_id && j.status !== 'completed')) throw new Blocked('Other unfinished Ticket-email jobs exist. Resolve preceding simulated runs first; Sandbox cannot send unrelated notifications.');
  const claim = await a.write('email-claim', '/v1/admin/notification-jobs/claims', { actor: system, limit: 100, kinds: ['tickets_ready'] });
  const claimed = claim.data.jobs.find(j => j.job_id === job.job_id);
  if (!claimed) throw new Blocked('Target job is not claimable. Recover its existing claim before dispatch.');
  if (a.run.profile === 'simulation') for (const preceding of claim.data.jobs.filter(j => j.job_id !== job.job_id)) {
    if (preceding.requires_verification) throw new Blocked('A preceding claimed job requires dispatch verification. No blind simulated resend.');
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
  await a.write('email-delivered', `/v1/admin/notification-jobs/${id(job.job_id)}/delivery-reports`, { actor: system, outcome: 'delivered', provider_message_reference: messageReference, provider_event_reference: `${a.run.profile}-observed-delivery-${job.job_id}`, observed_at: observedAt });
  const after = await a.read('delivered-order', `/v1/public/orders/${id(f.order.order_token)}`, { fresh: true });
  a.check('delivery observed', after.data.delivery_status === 'delivered', 'Delivery has separate evidence', after.data.delivery_status);
}
async function admit(a, f, { concurrency = false } = {}) {
  const p = `/v1/admin/events/${id(f.e.event_id)}`;
  const lookup = await a.write('lookup-reference', p + '/ticket-lookup', { order_reference: f.order.order_reference });
  a.check('lookup no page secrets', !/order_token|ticket_token|qr_payload|qr_token/.test(JSON.stringify(lookup.envelope)), 'Staff lookup contains no access tokens or QR', { orders: lookup.data.length });
  await a.write('lookup-email', p + '/ticket-lookup', { email: a.run.profile === 'sandbox' ? a.config.operatorEmail : 'buyer@fake-lmnl.test' });
  await a.write('invalid-qr', p + '/admissions', { actor: human, qr_token: 'invalid-qr-token' }, [404], { expectedError: 'not_found' });
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
export async function execute(a) {
  const workflow = a.run.workflow;
  if (workflow === 'service') { await configuration(a); return; }
  if (workflow === 'checkout' || workflow === 'closure') { await closure(a); return; }
  if (workflow === 'configuration') {
    await configuration(a); await a.read('missing-key', '/v1/admin/payment-configuration', { auth: 'none', expected: [401], expectedError: 'unauthorized' });
    const otherConfig = await a.read('other-Site-configuration', '/v1/admin/payment-configuration', { auth: 'other' });
    a.check('shared test connection', otherConfig.data?.active_connection?.connection_id === a.config.connectionId, 'Both dedicated Sites must share the test connection; assign it to the secondary Site with the operator CLI', otherConfig.data?.active_connection?.connection_id);
    await a.read('other-Site-shared-connection', `/v1/admin/payment-connections/${id(a.config.connectionId)}`, { auth: 'other' });
    const f = await fixture(a);
    const denied = {
      event: `/v1/admin/events/${id(f.e.event_id)}`, 'public-event': `/v1/public/events/${id(f.e.event_id)}`,
      'related-orders': `/v1/admin/events/${id(f.e.event_id)}/orders`, 'related-tickets': `/v1/admin/events/${id(f.e.event_id)}/tickets`,
      order: `/v1/admin/orders/${id(f.order.order_id)}`, attempt: `/v1/admin/payment-attempts/${id(f.at.attempt_id)}`,
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
      await a.call('capacity-floor', p, { method: 'PATCH', body: { actor: human, expected_version: e.version, ticket_offering: { capacity: 0 } }, expected: [409], expectedError: 'below_committed_capacity' });
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
  const f = await fixture(a);
  if (workflow === 'conflict') {
    await a.write('conflicting-payment', `/v1/admin/payment-attempts/${id(f.at.attempt_id)}/payment-reports`, { ...f.body, amount: f.body.amount + 1 }, [409], { expectedError: 'payment_report_conflict' });
    const after = await a.read('paid-after-conflict', `/v1/public/orders/${id(f.order.order_token)}`); a.check('paid facts retained', after.data.payment_status === 'paid' && after.data.tickets[0].ticket_id === f.ticket.ticket_id, 'Conflict preserves confirmed payment and Ticket', { payment: after.data.payment_status, tickets: after.data.tickets.length });
  }
  if (['delivery', 'durable-jobs', 'unknown-email', 'journey'].includes(workflow)) await deliver(a, f, { unknown: workflow === 'unknown-email', overlap: workflow === 'durable-jobs' });
  if (workflow === 'durable-jobs') await a.scheduler('bounded-scheduler');
  if (['admission', 'journey'].includes(workflow)) await admit(a, f, { concurrency: workflow === 'admission' });
}
