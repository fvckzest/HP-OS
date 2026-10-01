import { randomUUID } from 'node:crypto';
import { hash, redact } from './evidence.mjs';
export class Pause extends Error {}
export class Unknown extends Error {}
export class Blocked extends Error {}
export class Adapter {
  constructor(config, run, store, signal, fetchImpl = fetch) {
    Object.assign(this, { config, run, store, signal, fetchImpl });
    this.secrets = [config.siteKey, config.otherSiteKey, config.squareToken, config.resendKey, config.cronSecret];
  }
  async save() { await this.store.save(this.run); }
  check(name, condition, expected, actual) {
    this.run.checks = this.run.checks.filter(c => c.name !== name);
    this.run.checks.push({ name, expected, actual: redact(actual, this.secrets), passed: Boolean(condition) });
    if (!condition) throw new Error(`${name}: ${expected}`);
  }
  async call(name, path, { method = 'GET', body, expected = [200], key, auth = 'primary', provider = 'hpos', fresh = false, expectedError } = {}) {
    this.signal.throwIfAborted();
    let origin, secret;
    if (provider === 'hpos') {
      if (!/^\/v1\/(?:admin|public)\/[A-Za-z0-9_/?=&.%-]+$/.test(path) && path !== '/api/cron/process') throw new Error('Unapproved API path.');
      origin = this.config.origin;
      secret = auth === 'other' ? this.config.otherSiteKey : auth === 'none' ? '' : path === '/api/cron/process' ? this.config.cronSecret : this.config.siteKey;
    } else {
      if (this.run.profile !== 'sandbox') throw new Blocked('External providers require the explicitly selected Sandbox profile.');
      if (provider === 'square' && /^\/v2\/(?:online-checkout\/payment-links|orders\/[A-Za-z0-9_-]+|payments\/[A-Za-z0-9_-]+|locations\/[A-Za-z0-9_-]+)$/.test(path)) {
        origin = 'https://connect.squareupsandbox.com'; secret = this.config.squareToken;
      } else if (provider === 'resend' && /^\/emails(?:\/[A-Za-z0-9_-]+)?$/.test(path)) {
        origin = 'https://api.resend.com'; secret = this.config.resendKey;
        if (method === 'POST' && (JSON.stringify(body?.to) !== JSON.stringify([this.config.operatorEmail]) || body?.from !== this.config.resendFrom)) throw new Blocked('External email must use the configured sender and operator-owned recipient.');
      } else throw new Error('Unapproved provider operation.');
    }
    const fingerprint = hash({ provider, path, method, body, auth });
    let entry = this.run.journal[name];
    if (entry && entry.fingerprint !== fingerprint) throw new Blocked('A resumed step differs from its saved request.');
    if (!entry) entry = this.run.journal[name] = { fingerprint, key: key || randomUUID(), state: 'new' };
    const validate = result => this.check(name + ': HTTP outcome', expected.includes(result.status) && (!expectedError || result.error?.code === expectedError), `HTTP ${expected.join(' or ')}${expectedError ? ' with ' + expectedError : ''}`, { status: result.status, error: result.error?.code });
    if (entry.state === 'done' && !fresh) { validate(entry.result); return entry.result; }
    if (provider !== 'hpos' && method !== 'GET' && entry.state === 'pending' && Date.now() - this.run.clock >= 86_400_000) throw new Blocked('External idempotency may have expired. Verify provider/durable dispatch history before any resend; automatic retry is disabled.');
    const headers = { Accept: 'application/json' };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['Idempotency-Key'] = key || entry.key;
    if (provider === 'square') headers['Square-Version'] = '2026-09-16';
    entry.state = 'pending';
    const evidence = { name, provider, method, path: redact(path, this.secrets), expected: { statuses: expected, error: expectedError ?? null }, request: redact(body ?? null, this.secrets), requestKey: key || entry.key, startedAt: new Date().toISOString(), state: 'waiting for response' };
    this.run.steps.push(evidence);
    await this.save();
    try {
      const response = await this.fetchImpl(origin + path, { method, headers, redirect: 'error', cache: 'no-store', ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]) });
      const json = await response.json();
      entry.result = { status: response.status, data: json.data, envelope: json, error: json.error, cacheControl: response.headers.get('cache-control') };
      evidence.actual = { status: response.status, response: redact(json, this.secrets), cacheControl: entry.result.cacheControl };
      if (response.status >= 500 || response.status === 429 || json.error?.code === 'request_in_progress') {
        entry.state = 'pending';
        if (method === 'GET') throw new Blocked(`Read blocked by HTTP ${response.status} from ${provider}. Check the service, then resume explicitly.`);
        throw new Unknown('Retryable HTTP outcome.');
      }
      entry.state = 'done';
      await this.save();
      validate(entry.result);
      return entry.result;
    } catch (error) {
      if (entry.state !== 'done') {
        const errorCode = error.cause?.code ?? error.code ?? error.name;
        evidence.actual ??= { outcome: method === 'GET' ? 'read did not complete' : 'unknown mutation outcome', errorCode };
        if (method === 'GET') {
          if (error instanceof Blocked) throw error;
          if (this.signal.aborted) throw new Pause('Read interrupted. Resume explicitly when the service is available.');
          const hint = provider === 'hpos' ? `HP-OS could not be reached at ${origin}. Start HP-OS with pnpm local and check the Docker connection.` : `${provider} could not be reached. Check its test-service configuration.`;
          throw new Blocked(`${hint} Connection error: ${errorCode}.`);
        }
        throw new Unknown(this.signal.aborted ? 'Interrupted. A mutation may have committed; resume this saved run.' : 'The HTTP outcome is uncertain. Resume this saved run with its original request identities.');
      }
      throw error;
    } finally { evidence.state = 'finished'; evidence.finishedAt = new Date().toISOString(); await this.save(); }
  }
  async read(name, path, options) { return this.call(name, path, options); }
  async write(name, path, body, expected = [200], options = {}) { return this.call(name, path, { method: 'POST', body, expected, ...options }); }
  async scheduler(name) { return this.call(name, '/api/cron/process'); }
}
