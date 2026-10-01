import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sensitive = /authorization|api.?key|access.?token|order_token|ticket_token|approval_token|qr_(?:payload|token)|secret|password|recipient_email|delivery_email|^email$|^to$|^from$|buyer_name|attendee_name|^name$|^html$|^text$|^url$|long_url/i;
export function redact(value, secrets = []) {
  if (Array.isArray(value)) return value.map(x => redact(x, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, sensitive.test(key) ? '[redacted]' : redact(v, secrets)]));
  if (typeof value !== 'string') return value;
  let out = value.replace(/Bearer\s+[^\s"]+/gi, 'Bearer [redacted]').replace(/hpos_site_[A-Za-z0-9_-]+/g, '[redacted]');
  for (const s of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(s).join('[redacted]');
  return out.replace(/(\/v1\/public\/(?:orders|tickets|access-requests)\/)(?!\{)[^/?\s]+/g, '$1[redacted]');
}
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export class RunStore {
  constructor(directory) { this.directory = directory; this.queue = Promise.resolve(); }
  async init() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
  async save(run) {
    const serialized = JSON.stringify(run, null, 2);
    this.queue = this.queue.catch(() => {}).then(async () => {
      const file = path.join(this.directory, `${run.id}.json`);
      await writeFile(file + '.tmp', serialized, { mode: 0o600 });
      await rename(file + '.tmp', file);
    });
    await this.queue;
  }
  async read(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid run identifier.');
    return JSON.parse(await readFile(path.join(this.directory, `${id}.json`), 'utf8'));
  }
  async all() {
    const files = (await readdir(this.directory)).filter(f => /^[0-9a-f-]{36}\.json$/.test(f));
    return (await Promise.all(files.map(f => this.read(f.slice(0, -5))))).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
export function publicRun(run, secrets) {
  const { journal, privateContext, fingerprint, ...safe } = run;
  const result = redact(safe, secrets);
  // These names identify controlled workflow steps and checks, not buyer names.
  if (safe.steps) result.steps = result.steps.map((step, i) => ({ ...step, name: safe.steps[i].name }));
  if (safe.checks) result.checks = result.checks.map((check, i) => ({ ...check, name: safe.checks[i].name }));
  return result;
}
