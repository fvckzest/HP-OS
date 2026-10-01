import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, blockers } from './config.mjs';
import { groups, routes, workflows, ticketChecklist } from './catalog.mjs';
import { RunStore, publicRun, hash, redact } from './evidence.mjs';
import { Adapter, Pause, Unknown, Blocked } from './adapter.mjs';
import { execute } from './workflows.mjs';

const assetFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
export async function createDashboard({ config = loadConfig(), directory = fileURLToPath(new URL('./data/', import.meta.url)), fetchImpl = fetch } = {}) {
  const store = new RunStore(directory); await store.init();
  const source = JSON.parse(await readFile(new URL('./source-snapshot.json', import.meta.url), 'utf8'));
  const codeFiles = (await readdir(new URL('./', import.meta.url))).filter(f => f.endsWith('.mjs')).sort();
  const dashboardHash = hash(await Promise.all(codeFiles.map(f => readFile(new URL(f, import.meta.url), 'utf8'))));
  const secrets = [config.siteKey, config.otherSiteKey, config.squareToken, config.resendKey, config.cronSecret];
  const csrf = randomBytes(32).toString('hex'), active = new Map();
  for (const run of await store.all()) {
    if (run.status === 'unknown outcome' && run.workflow === 'service' && run.steps.length && run.steps.every(step => step.method === 'GET')) {
      run.status = 'blocked';
      run.message = 'The service read did not complete. No mutation was attempted. Start HP-OS with pnpm local, then explicitly run the service observation again.';
      await store.save(run);
    }
    if (run.status === 'running') {
      run.status = Object.values(run.journal).some(j => j.state === 'pending') ? 'unknown outcome' : 'interrupted';
      run.message = 'Container restarted. No workflow was resumed automatically. Resume explicitly using saved request identities.';
      await store.save(run);
    }
  }
  async function launch(run) {
    const controller = new AbortController(); active.set(run.id, controller);
    run.status = 'running'; run.message = 'Explicit run started.'; await store.save(run);
    const a = new Adapter(config, run, store, controller.signal, fetchImpl);
    try {
      await execute(a);
      if (run.checks.some(c => !c.passed)) throw new Error('A required scenario check failed.');
      run.status = 'passed'; run.message = 'This scenario passed in the recorded profile. Ticket acceptance and release gates remain separate.';
    } catch (error) {
      run.status = error instanceof Pause ? 'interrupted' : error instanceof Blocked ? 'blocked' : error instanceof Unknown ? 'unknown outcome' : controller.signal.aborted ? 'interrupted' : 'failed';
      run.message = redact(error.message, secrets);
    } finally {
      run.finishedAt = new Date().toISOString(); await store.save(run); active.delete(run.id);
    }
  }
  const server = createServer(async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
    const send = (status, value, type = 'application/json') => { res.writeHead(status, { ...headers, 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(value) : value); };
    try {
      const allowedHosts = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
      if (!allowedHosts.includes(req.headers.host)) return send(403, { error: 'Use the local dashboard address.' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ready: true, automaticWorkflowExecution: false });
      if (req.method === 'GET' && assetFiles[url.pathname]) {
        const [file, type] = assetFiles[url.pathname]; return send(200, await readFile(new URL('./public/' + file, import.meta.url)), type);
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const saved = await store.all();
        return send(200, {
          csrf, groups, routes, tickets: ticketChecklist(), source, dashboardHash,
          environment: { origin: config.origin, container: config.docker, configured: Boolean(config.siteKey), revisionNote: 'HP-OS source snapshot captured before image build. This is not verification of the running HP-OS server revision.' },
          workflows: workflows.map(w => ({ ...w, blockers: Object.fromEntries(['simulation', 'sandbox'].map(p => [p, blockers(w, p, config)])) })),
          runs: saved.map(r => ({ ...publicRun(r, secrets), hasCheckout: Boolean(r.privateContext.square?.link?.url), hasOrder: Boolean(r.privateContext.order), hasTicket: Boolean(r.privateContext.ticket) })),
        });
      }
      if (req.method === 'GET' && /^\/api\/evidence\/[0-9a-f-]{36}$/.test(url.pathname)) {
        return send(200, publicRun(await store.read(url.pathname.split('/').at(-1)), secrets));
      }
      if (req.method === 'GET' && /^\/api\/checkout\/[0-9a-f-]{36}$/.test(url.pathname)) {
        const run = await store.read(url.pathname.split('/').at(-1)), target = new URL(run.privateContext.square?.link?.url);
        if (run.profile !== 'sandbox' || target.protocol !== 'https:' || target.username || target.password || !['connect.squareupsandbox.com', 'sandbox.square.link', 'square.link', 'checkout.square.site', 'sandbox.checkout.square.site'].includes(target.hostname)) return send(403, { error: 'No verified Sandbox checkout link.' });
        res.writeHead(302, { ...headers, Location: target.href }); return res.end();
      }
      if (req.method === 'GET' && /^\/buyer\/(order|ticket)\/[0-9a-f-]{36}$/.test(url.pathname)) {
        const [, , kind, runId] = url.pathname.split('/'), run = await store.read(runId);
        const token = kind === 'order' ? run.privateContext.order?.order_token : run.privateContext.ticket?.ticket_token;
        if (!token) return send(404, { error: 'No buyer record in this saved run.' });
        const response = await fetchImpl(config.origin + `/v1/public/${kind}s/${encodeURIComponent(token)}`, { headers: { Authorization: `Bearer ${config.siteKey}` }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) });
        return send(response.status, { page: `Fake LMNL ${kind} page`, current: redact(await response.json(), secrets), note: 'Current API data. Access tokens and QR credentials are omitted from this local JSON presentation.' });
      }
      if (req.method !== 'POST' || !['/api/run', '/api/resume', '/api/interrupt'].includes(url.pathname)) return send(404, { error: 'Route unavailable.' });
      if (req.headers['x-test-site-token'] !== csrf || req.headers.origin !== `http://${req.headers.host}` || req.headers['content-type'] !== 'application/json') return send(403, { error: 'Use an explicit action from this dashboard.' });
      let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 8192) return send(413, { error: 'Request too large.' }); }
      const body = JSON.parse(raw);
      if (url.pathname === '/api/interrupt') {
        const controller = active.get(body.runId); if (!controller) return send(409, { error: 'Run is not active.' }); controller.abort(); return send(202, { accepted: true });
      }
      if (active.size) return send(409, { error: 'A workflow is already running. Internal concurrency is tested within its scenario.' });
      let run;
      if (url.pathname === '/api/resume') {
        run = await store.read(body.runId);
        if (!['interrupted', 'unknown outcome', 'blocked'].includes(run.status)) return send(409, { error: 'Only an interrupted, unknown, or blocked saved run can resume.' });
        if (run.fingerprint !== config.fingerprint || run.dashboardHash !== dashboardHash || hash(run.source) !== hash(source)) return send(409, { error: 'Configuration or source snapshot changed. Review previous uncertainty before starting a different workflow.' });
        if (body.paymentId && run.profile === 'sandbox') {
          if (run.journal['paid-report']) return send(409, { error: 'Payment report already started; its payment identity cannot be replaced.' });
          run.privateContext.paymentId = body.paymentId;
        }
      } else {
        const workflow = workflows.find(w => w.id === body.workflow), profile = body.profile;
        if (!workflow) return send(404, { error: 'Unavailable workflow. Hosted, cutover and sales-opening checks cannot be executed here.' });
        const reasons = blockers(workflow, profile, config); if (reasons.length) return send(409, { error: reasons.join(' ') });
        run = { id: randomUUID(), workflow: workflow.id, ticket: workflow.ticket, title: workflow.title, scope: workflow.scope ?? 'Scenario checks only; full ticket acceptance remains separate.', profile, environment: 'local Docker/HTTP' , origin: config.origin,
          source, dashboardHash, fingerprint: config.fingerprint, startedAt: new Date().toISOString(), clock: Date.now(), status: 'not run', message: '', checks: [], steps: [], journal: {}, privateContext: {},
          limitations: profile === 'simulation' ? ['Synthetic provider and notification evidence only.', 'No hosted, provider, device, fee settlement, cutover or release proof.'] : ['Square Sandbox and real operator-only Resend evidence; not production.', 'No LMNL UI, device, fee-settlement, hosted or release proof.'] };
      }
      // launch sets active before its first await; the response only acknowledges this action.
      launch(run).catch(() => { active.delete(run.id); });
      return send(202, { runId: run.id });
    } catch (error) { return send(error.code === 'ENOENT' ? 404 : 400, { error: redact(error.message, secrets) }); }
  });
  return { server, store, active };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig(), { server } = await createDashboard({ config });
  server.listen(config.port, config.bind, () => console.log(`Fake LMNL: http://127.0.0.1:${config.port}. No workflows run on startup or refresh.`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
}
