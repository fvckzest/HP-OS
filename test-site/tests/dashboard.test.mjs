import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { loadConfig, blockers } from '../config.mjs';
import { routes, documentedRoutes, tickets, workflows, ticketChecklist } from '../catalog.mjs';
import { publicRun, RunStore } from '../evidence.mjs';
import { Adapter, Unknown, Blocked } from '../adapter.mjs';
import { createDashboard } from '../server.mjs';
import { settleRequests, execute } from '../workflows.mjs';

const config = () => loadConfig({ HPOS_SITE_API_KEY: 'private-site-key', HPOS_OTHER_SITE_API_KEY: 'private-other-key', HPOS_SITE_ID: 'dedicated-site', HPOS_CONNECTION_ID: 'dedicated-connection', TEST_SITE_PORT: '3198' });
const run = () => ({ id: '12345678-1234-1234-1234-123456789012', clock: Date.now(), profile: 'simulation', status: 'not run', steps: [], checks: [], journal: {}, privateContext: {}, startedAt: new Date().toISOString() });
const response = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
async function tempStore(t) { const directory = await mkdtemp(path.join(os.tmpdir(), 'fake-lmnl-test-')); t.after(() => rm(directory, { recursive: true, force: true })); const store = new RunStore(directory); await store.init(); return store; }

test('all current documented routes and tickets have explicit coverage, with release actions gated', async () => {
  const docs = await Promise.all(['api.md', 'api-ref.md'].map(f => readFile(new URL('../../docs/api/' + f, import.meta.url), 'utf8')));
  assert.deepEqual(routes.map(r => r.route).sort(), documentedRoutes(...docs));
  assert.equal(routes.length, 49);
  assert.deepEqual(tickets.map(t => t.number), Array.from({ length: 33 }, (_, i) => i + 23));
  assert.ok(routes.every(r => r.tickets.length && r.tickets.every(n => n >= 23 && n <= 55)));
  assert.ok(routes.every(r => r.implemented), 'every documented route has a current HP-OS handler');
  assert.ok(workflows.every(w => w.ticket < 51));
  assert.equal(routes.find(r => r.route.includes('/refund-reports')).implemented, true);
  assert.equal(routes.find(r => r.route.includes('/apple-wallet-data')).implemented, true);
  assert.equal(routes.find(r => r.route.includes('/access-requests')).implemented, true);
  for (const id of ['arrival-change', 'cancellation', 'refund', 'reporting', 'connection-history', 'private-approval', 'private-purchase', 'wallet-data', 'wallet-updates', 'group-purchase']) {
    assert.ok(workflows.some(workflow => workflow.id === id), 'missing local workflow: ' + id);
  }
  const checklist = ticketChecklist();
  assert.equal(checklist.find(ticket => ticket.number === 50).gate, 'not run');
  assert.equal(checklist.find(ticket => ticket.number === 45).gate, 'blocked');
});
test('Issue #33 journey runs its connected single-ticket checkpoints in order', async () => {
  const calls = [], checks = [];
  const connection = { connection_id: 'dedicated-connection', environment: 'test' };
  const event = { event_id: 'event-one', version: 2, ticket_offering: { available_quantity: 8 } };
  const order = {
    order_id: 'order-one', order_reference: 'ORDER-ONE', order_token: 'order-token', quantity: 1, reservation: { quantity: 1, status: 'held' },
    pricing: { total: { amount: 2500, currency: 'USD' } }, payment_status: 'unpaid', tickets: [],
  };
  const ticket = { ticket_id: 'ticket-one', ticket_token: 'ticket-token', qr_payload: 'Q'.repeat(32), ordinal: 1 };
  const issued = { ...order, payment_status: 'paid', issuance_status: 'issued', delivery_status: 'pending', tickets: [ticket] };
  const delivered = { ...issued, delivery_status: 'delivered' };
  const job = { job_id: 'job-one', order_id: order.order_id, kind: 'tickets_ready', status: 'pending', requires_verification: false };
  const claimed = { ...job, claim_id: 'claim-one', lease_fence: 1, lease_expires_at: new Date(Date.now() + 60_000).toISOString(), is_superseded: false };
  const saved = {
    id: '12345678-1234-1234-1234-123456789012', workflow: 'journey', profile: 'simulation', clock: Date.now(),
    status: 'not run', steps: [], checks: [], journal: {}, privateContext: {},
  };
  const adapter = {
    run: saved,
    config: { connectionId: connection.connection_id },
    save: async () => {},
    check(name, condition, expected, actual) {
      checks.push({ name, passed: Boolean(condition) });
      assert.ok(condition, `${name}: ${expected}; actual ${JSON.stringify(actual)}`);
    },
    async call(name, path, options = {}) {
      calls.push({ name, path, options });
      saved.journal[name] = { key: options.key ?? name };
      if (options.expectedError) {
        return { status: options.expected?.[0] ?? 409, error: { code: options.expectedError }, data: null, envelope: { error: { code: options.expectedError } } };
      }
      let data;
      if (name === 'configuration') data = { active_connection: connection };
      else if (name === 'historical-connection') data = connection;
      else if (name.endsWith('-draft')) data = { ...event, version: 1 };
      else if (name.endsWith('-save') || name.endsWith('-publish')) data = event;
      else if (name.endsWith('-quote')) data = { quote_id: 'quote-one', total: order.pricing.total };
      else if (name === 'issued-order' || name === 'after-payment-replay') data = issued;
      else if (name === 'delivered-order') data = delivered;
      else if (name.endsWith('-order')) data = order;
      else if (name === 'attempt-create') data = { attempt_id: 'attempt-one', total: order.pricing.total, connection };
      else if (name === 'checkout-register') data = { provider_checkout_reference: options.body.provider_checkout_reference };
      else if (name === 'buyer-pending') data = order;
      else if (name === 'buyer-ticket') data = {
        ticket_id: ticket.ticket_id,
        qr_payload: ticket.qr_payload,
        admission_status: 'unused',
        can_admit: true,
      };
      else if (name === 'staff-payment-status') data = { payment_status: 'paid' };
      else if (name === 'email-list') data = [job];
      else if (name === 'email-frontier') data = [];
      else if (name === 'email-claim') data = { claim_id: claimed.claim_id, jobs: [claimed] };
      else if (name === 'email-recheck' || name === 'unknown-job') data = claimed;
      else if (name === 'sent-not-delivered') data = { delivery_status: 'pending' };
      else if (name === 'lookup-reference' || name === 'lookup-email') data = [];
      else if (name === 'scan-one' || name === 'scan-replay') data = { admission_id: 'admission-one' };
      else if (name === 'after-admission') data = { admission_status: 'admitted', can_admit: false };
      else data = {};
      const status = options.expected?.[0] ?? 200;
      return { status, data, envelope: { data } };
    },
    read(name, path, options) { return this.call(name, path, options); },
    write(name, path, body, expected = [200], options = {}) { return this.call(name, path, { method: 'POST', body, expected, ...options }); },
    scheduler(name) { return this.call(name, '/api/cron/process'); },
  };

  await execute(adapter);

  assert.deepEqual(calls.map(call => call.name), [
    'configuration', 'historical-connection', 'event-draft', 'event-save', 'event-publish',
    'purchase-quote', 'purchase-order', 'attempt-create', 'checkout-register', 'buyer-pending',
    'paid-report', 'issued-order', 'buyer-ticket', 'staff-payment-status', 'paid-report-duplicate-source',
    'after-payment-replay', 'email-list', 'email-frontier', 'email-claim', 'email-recheck', 'email-dispatch',
    'sent-not-delivered', 'email-delivered', 'delivered-order', 'lookup-reference',
    'lookup-email', 'invalid-qr', 'scan-one', 'scan-replay', 'scan-again', 'manual-again', 'after-admission',
  ]);
  const checkout = calls.find(call => call.name === 'checkout-register');
  assert.deepEqual(checkout.options.body.connection_id, connection.connection_id);
  assert.equal(checkout.options.body.provider_checkout_reference, 'fake-checkout-' + saved.id);
  assert.equal(calls.find(call => call.name === 'buyer-pending').path, '/v1/public/orders/order-token');
  assert.equal(calls.find(call => call.name === 'invalid-qr').options.body.qr_token.length, 32);
  assert.equal(calls.find(call => call.name === 'email-dispatch').options.body.outcome, 'completed');
  assert.equal(calls.find(call => call.name === 'email-delivered').options.body.outcome, 'delivered');
  assert.ok(checks.some(check => check.name === 'buyer Ticket page' && check.passed));
  assert.equal(checks.filter(check => check.passed).length, checks.length);
});
test('local configuration rejects remote, credential-bearing and alternate-target origins', () => {
  for (const origin of ['https://example.com:3000', 'http://example.com:3000', 'http://127.0.0.1:3000/v1', 'http://user:pass@127.0.0.1:3000', 'http://127.0.0.1:443', 'http://host.docker.internal:3000']) assert.throws(() => loadConfig({ HPOS_ORIGIN: origin }));
  assert.equal(loadConfig({ TEST_SITE_CONTAINER: 'true', HPOS_ORIGIN: 'http://host.docker.internal:3000' }).bind, '0.0.0.0');
  assert.throws(() => loadConfig({ TEST_SITE_CONTAINER: 'true', HPOS_ORIGIN: 'http://production:3000' }));
  assert.ok(blockers(workflows.find(w => w.id === 'journey'), 'sandbox', config()).length);
});
test('export strips private replay data, bearer credentials, access paths and nested tokens', () => {
  const safe = publicRun({ ...run(), fingerprint: 'secret-fingerprint', journal: { key: 'private-history' }, privateContext: { ticket_token: 'private-ticket' }, steps: [{ path: '/v1/public/orders/private-order', request: { actor: { reference: 'private-site-key' }, qr_token: 'private-qr', buyer: { email: 'operator@example.com' } }, response: { ticket_token: 'private-ticket', nested: { authorization: 'Bearer private-site-key' } } }] }, ['private-site-key']);
  const text = JSON.stringify(safe);
  for (const secret of ['private-ticket', 'private-order', 'private-history', 'private-qr', 'private-site-key', 'operator@example.com', 'secret-fingerprint']) assert.ok(!text.includes(secret));
});
test('a lost mutation response persists its identity, and resumption creates no duplicate effect', async t => {
  const store = await tempStore(t), saved = run(), effects = new Map(), keys = [];
  let loseResponse = true;
  const fetchImpl = async (url, options) => {
    const key = options.headers['Idempotency-Key']; keys.push(key);
    if (!effects.has(key)) effects.set(key, { event_id: 'one-created-event' });
    if (loseResponse) { loseResponse = false; throw new Error('response lost after server committed'); }
    return response(201, { data: effects.get(key) });
  };
  const adapter = new Adapter(config(), saved, store, new AbortController().signal, fetchImpl);
  await assert.rejects(adapter.write('create', '/v1/admin/events', { actor: { type: 'user', reference: 'test' } }, [201]), Unknown);
  const persisted = await store.read(saved.id);
  assert.equal(persisted.journal.create.state, 'pending');
  const resumed = new Adapter(config(), persisted, store, new AbortController().signal, fetchImpl);
  const result = await resumed.write('create', '/v1/admin/events', { actor: { type: 'user', reference: 'test' } }, [201]);
  assert.equal(result.data.event_id, 'one-created-event'); assert.equal(effects.size, 1); assert.equal(keys[0], keys[1]);
  await assert.rejects(resumed.write('create', '/v1/admin/events', { actor: { type: 'user', reference: 'different' } }, [201]), Blocked);
});
test('a saved unexpected HTTP result remains failing when revisited', async t => {
  const store = await tempStore(t), saved = run();
  const adapter = new Adapter(config(), saved, store, new AbortController().signal, async () => response(422, { error: { code: 'validation_failed' } }));
  await assert.rejects(adapter.write('create', '/v1/admin/events', {}, [201]));
  await assert.rejects(adapter.write('create', '/v1/admin/events', {}, [201]));
  assert.equal(saved.checks[0].passed, false);
});
test('external calls require Sandbox, enforce one recipient and block expired uncertain sends', async t => {
  const store = await tempStore(t), c = config(), saved = run(); let requests = 0;
  const adapter = new Adapter(c, saved, store, new AbortController().signal, async () => { requests++; return response(200, { id: 'email-id' }); });
  await assert.rejects(adapter.call('send', '/emails', { provider: 'resend', method: 'POST', body: { from: '', to: ['someone@example.com'] } }), Blocked);
  saved.profile = 'sandbox'; c.operatorEmail = 'owner@example.com'; c.resendFrom = 'test@example.com';
  await assert.rejects(adapter.call('send', '/emails', { provider: 'resend', method: 'POST', body: { from: c.resendFrom, to: ['someone@example.com'] } }), Blocked);
  assert.equal(requests, 0);
  const body = { from: c.resendFrom, to: [c.operatorEmail] };
  const uncertain = new Adapter(c, saved, store, new AbortController().signal, async () => { throw new Error('unknown send'); });
  await assert.rejects(uncertain.call('send', '/emails', { provider: 'resend', method: 'POST', body }), Unknown);
  saved.clock -= 86_400_001;
  await assert.rejects(uncertain.call('send', '/emails', { provider: 'resend', method: 'POST', body }), Blocked);
});
test('dashboard startup, health, status, and forbidden browser actions send no HP-OS requests', async t => {
  const store = await tempStore(t), c = config(); let outbound = 0;
  const { server } = await createDashboard({ config: c, directory: store.directory, fetchImpl: async () => { outbound++; throw new Error('unexpected outbound'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  c.port = server.address().port;
  const origin = `http://127.0.0.1:${server.address().port}`, headers = { Host: `127.0.0.1:${c.port}` };
  for (const url of ['/', '/health', '/api/status', '/api/status']) assert.equal((await fetch(origin + url, { headers })).status, 200);
  const status = await (await fetch(origin + '/api/status', { headers })).json();
  assert.equal(status.runs.length, 0);
  assert.ok(!JSON.stringify(status).includes(c.siteKey));
  assert.equal((await fetch(origin + '/api/run', { method: 'POST', headers: { ...headers, Origin: `http://127.0.0.1:${c.port}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow: 'service', profile: 'simulation' }) })).status, 403);
  assert.equal((await fetch(origin + '/api/run', { method: 'POST', headers: { ...headers, Origin: `http://127.0.0.1:${c.port}`, 'Content-Type': 'application/json', 'X-Test-Site-Token': status.csrf }, body: JSON.stringify({ workflow: 'production-refund', profile: 'sandbox' }) })).status, 404);
  const rebindingStatus = await new Promise((resolve, reject) => { const r = request(origin + '/api/status', { headers: { Host: 'attacker.example:3198' } }, response => { response.resume(); resolve(response.statusCode); }); r.on('error', reject); r.end(); });
  assert.equal(rebindingStatus, 403);
  assert.equal(outbound, 0);
});
test('container restart preserves uncertain runs and never resumes them automatically', async t => {
  const store = await tempStore(t), saved = run(); saved.status = 'running'; saved.journal.create = { state: 'pending', key: 'original-key' }; await store.save(saved);
  let outbound = 0;
  await createDashboard({ config: config(), directory: store.directory, fetchImpl: async () => { outbound++; } });
  const recovered = await store.read(saved.id); assert.equal(recovered.status, 'unknown outcome'); assert.equal(recovered.journal.create.key, 'original-key'); assert.equal(outbound, 0);
});
test('concurrent requests settle before a run can finish; uncertainty takes precedence', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  let finished = false;
  const result = settleRequests([Promise.reject(new Error('known failure')), delayed.then(() => { throw new Unknown('lost response'); })]).catch(error => { finished = true; return error; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release();
  assert.ok(await result instanceof Unknown);
});
test('pending HTTP call is visible before response; refused reads are blocked with connection details', async t => {
  const store = await tempStore(t), saved = run();
  let finish;
  const adapter = new Adapter(config(), saved, store, new AbortController().signal, async () => {
    const onDisk = await store.read(saved.id);
    assert.equal(onDisk.steps[0].path, '/v1/admin/payment-configuration');
    assert.equal(onDisk.steps[0].state, 'waiting for response');
    assert.equal(publicRun(onDisk, []).steps[0].name, 'configuration');
    await new Promise(resolve => { finish = resolve; });
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
  });
  const result = adapter.read('configuration', '/v1/admin/payment-configuration').catch(error => error);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  finish(); const error = await result;
  assert.ok(error instanceof Blocked);
  assert.match(error.message, /pnpm local/); assert.match(error.message, /ECONNREFUSED/);
  assert.equal(saved.steps[0].actual.outcome, 'read did not complete');
});
test('Interrupt cancels an active read and unlocks subsequent workflow actions', async t => {
  const store = await tempStore(t), c = config(); let started;
  const observedStart = new Promise(resolve => { started = resolve; });
  const { server, active } = await createDashboard({ config: c, directory: store.directory, fetchImpl: (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('interrupted', 'AbortError')), { once: true }); started();
  }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); c.port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${c.port}`, status = await (await fetch(origin + '/api/status')).json();
  const post = (url, body) => fetch(origin + url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Test-Site-Token': status.csrf }, body: JSON.stringify(body) });
  const launched = await post('/api/run', { workflow: 'service', profile: 'simulation' }); assert.equal(launched.status, 202);
  const { runId } = await launched.json(); await observedStart;
  const running = await (await fetch(origin + '/api/status')).json(); assert.equal(running.runs[0].status, 'running'); assert.equal(running.runs[0].steps[0].state, 'waiting for response');
  assert.equal((await post('/api/interrupt', { runId })).status, 202);
  while (active.size) await new Promise(resolve => setImmediate(resolve));
  const ended = await (await fetch(origin + '/api/status')).json(); assert.equal(ended.runs[0].status, 'interrupted');
  assert.equal((await post('/api/interrupt', { runId })).status, 409);
  assert.equal(active.size, 0);
});
test('previous service-only read failure is corrected without starting requests or discarding evidence', async t => {
  const store = await tempStore(t), saved = run(); saved.workflow = 'service'; saved.status = 'unknown outcome'; saved.steps = [{ method: 'GET', path: '/v1/admin/payment-configuration', actual: { outcome: 'interrupted read' } }]; await store.save(saved);
  let outbound = 0; await createDashboard({ config: config(), directory: store.directory, fetchImpl: async () => { outbound++; } });
  const corrected = await store.read(saved.id); assert.equal(corrected.status, 'blocked'); assert.equal(corrected.steps.length, 1); assert.equal(outbound, 0);
});
test('Sandbox delivery resume accepts the original payment ID and rejects replacement after reporting', async t => {
  const store = await tempStore(t), c = config();
  const { server, active } = await createDashboard({ config: c, directory: store.directory, fetchImpl: async () => { throw new Error('offline'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); c.port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${c.port}`, status = await (await fetch(origin + '/api/status')).json();
  const saved = { ...run(), workflow: 'service', profile: 'sandbox', status: 'interrupted', fingerprint: c.fingerprint, dashboardHash: status.dashboardHash, source: status.source };
  saved.privateContext.paymentId = 'original-payment'; saved.journal['paid-report'] = { state: 'done' }; await store.save(saved);
  const resume = paymentId => fetch(origin + '/api/resume', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Test-Site-Token': status.csrf }, body: JSON.stringify({ runId: saved.id, paymentId }) });
  assert.equal((await resume('different-payment')).status, 409);
  assert.equal((await resume('original-payment')).status, 202);
  while (active.size) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await store.read(saved.id)).privateContext.paymentId, 'original-payment');
  assert.equal((await resume('')).status, 202);
  while (active.size) await new Promise(resolve => setImmediate(resolve));
});
test('isolation scenario checks private records and provider references while both Sites share a connection', async () => {
  const saved = { ...run(), workflow: 'configuration' }, calls = [], connection = { connection_id: 'dedicated-connection', environment: 'test' };
  const ticket = { ticket_id: 'ticket-one', ticket_token: 'ticket-token', qr_payload: 'qr-one', ordinal: 1 };
  const order = { order_id: 'order-one', order_token: 'order-token', quantity: 1, reservation: { quantity: 1, status: 'held' }, pricing: { total: { amount: 2500, currency: 'USD' } }, payment_status: 'unpaid', tickets: [] };
  const issued = { ...order, payment_status: 'paid', issuance_status: 'issued', tickets: [ticket] };
  const adapter = {
    run: saved, config: config(), save: async () => {}, check: (name, condition) => assert.ok(condition, name),
    async call(name, path, options = {}) {
      calls.push({ name, path, ...options }); saved.journal[name] = { key: name };
      if (options.expectedError) return { status: options.expected[0], error: { code: options.expectedError } };
      let data;
      if (path.endsWith('/payment-configuration')) data = { active_connection: connection };
      else if (path.includes('/payment-connections/')) data = connection;
      else if (['issued-order', 'after-payment-replay'].includes(name)) data = issued;
      else if (name.endsWith('-quote')) data = { quote_id: name };
      else if (name.endsWith('-order')) data = { ...order, order_id: name, order_token: name + '-token' };
      else if (name.endsWith('-create')) data = { attempt_id: name, total: order.pricing.total, connection };
      else if (name === 'checkout-register') data = { provider_checkout_reference: options.body.provider_checkout_reference };
      else if (name === 'buyer-pending') data = order;
      else if (name === 'buyer-ticket') data = {
        ticket_id: ticket.ticket_id,
        qr_payload: ticket.qr_payload,
        admission_status: 'unused',
        can_admit: true,
      };
      else data = { event_id: 'event-' + (options.auth ?? 'primary'), version: 1, ticket_offering: { available_quantity: 8 } };
      return { status: options.expected?.[0] ?? 200, data, envelope: { data } };
    },
    read(name, path, options) { return this.call(name, path, options); },
    write(name, path, body, expected = [200], options = {}) { return this.call(name, path, { method: 'POST', body, expected, ...options }); },
  };
  await execute(adapter);
  assert.equal(calls.find(c => c.name === 'other-Site-shared-connection').expectedError, undefined);
  for (const name of ['event', 'public-event', 'payment-status', 'attempt', 'order-token', 'ticket-token', 'provider-reference']) {
    const call = calls.find(c => c.name === 'other-Site-' + name);
    assert.equal(call.auth, 'other'); assert.deepEqual(call.expected, [404]); assert.equal(call.expectedError, 'not_found');
  }
  const reuse = calls.find(c => c.name === 'other-Site-provider-reference');
  assert.equal(reuse.body.connection_id, connection.connection_id);
  assert.equal(reuse.body.provider_checkout_reference, calls.find(c => c.name === 'checkout-register').body.provider_checkout_reference);
  assert.equal(saved.privateContext.order.order_id, 'purchase-order');
  assert.equal(saved.privateContext.attempt.attempt_id, 'attempt-create');
  for (const call of calls) {
    const route = routes.find(r => new RegExp('^' + r.route.split(' ').slice(1).join(' ').replace(/\{[^}]+\}/g, '[^/]+') + '$').test(call.path));
    if (route) assert.equal(route.implemented, true, call.path);
  }
});
test('cross-Site reference conflicts fail contract checks instead of being accepted as isolation proof', async t => {
  const store = await tempStore(t), saved = run();
  const adapter = new Adapter(config(), saved, store, new AbortController().signal, async () => response(409, { error: { code: 'provider_reference_conflict', message: 'Already attached to another attempt.' } }));
  await assert.rejects(adapter.write('other-Site-provider-reference', '/v1/admin/payment-attempts/secondary-attempt/checkout-reference', {
    connection_id: 'dedicated-connection', provider_checkout_reference: 'primary-reference', provider_can_take_payment: true,
  }, [404], { auth: 'other', expectedError: 'not_found' }), /HTTP 404 with not_found/);
  assert.equal(saved.checks[0].passed, false);
  assert.equal(saved.steps[0].actual.status, 409);
});
