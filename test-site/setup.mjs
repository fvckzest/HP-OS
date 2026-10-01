import { execFileSync } from 'node:child_process';
import { writeFile, readFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('./.env', import.meta.url);
async function optionalText(file) { try { return await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } }
let text = await optionalText(output);
const configured = { ...parseEnv(await optionalText(new URL('./.env.local', import.meta.url))), ...parseEnv(text) };
if (configured.HPOS_SITE_API_KEY) throw new Error('A Site key is already configured. Setup does not replace keys or create duplicate Sites.');
const env = { ...process.env, HPOS_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', HPOS_OPERATOR_ALLOW_REMOTE: 'false' };
function operator(...args) {
  try { return JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/operator.ts', ...args], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch { throw new Error('Local operator setup failed. Start HP-OS local PostgreSQL first. Partially created records are retained; no database cleanup runs automatically.'); }
}
const org = operator('organization', 'create', '--name', 'Fake LMNL local only', '--pilot-fee-rate-basis-points', '1000');
const site = operator('site', 'create', '--organization', org.organization_id, '--name', 'Fake LMNL');
const other = operator('site', 'create', '--organization', org.organization_id, '--name', 'Fake LMNL isolation');
const connection = operator('payment-connection', 'create', '--organization', org.organization_id, '--provider', 'square', '--environment', 'test', '--account-reference', 'ref:fake-lmnl-square', '--location-reference', 'ref:fake-lmnl-location');
operator('payment-connection', 'eligibility-record', '--connection', connection.connection_id, '--account-status', 'eligible', '--platform-fee-status', 'ineligible', '--evidence-reference', 'ref:fake-lmnl-simulation-only');
operator('site', 'assign-connection', '--site', site.site_id, '--connection', connection.connection_id);
const key = operator('site-key', 'issue', '--site', site.site_id);
const otherKey = operator('site-key', 'issue', '--site', other.site_id);
const values = { HPOS_ORIGIN: 'http://127.0.0.1:3000', HPOS_SITE_API_KEY: key.site_api_key, HPOS_OTHER_SITE_API_KEY: otherKey.site_api_key, HPOS_SITE_ID: site.site_id, HPOS_CONNECTION_ID: connection.connection_id, SQUARE_ACCOUNT_ALIAS: 'ref:fake-lmnl-square', SQUARE_LOCATION_ALIAS: 'ref:fake-lmnl-location' };
for (const [name, value] of Object.entries(values)) {
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  if (pattern.test(text)) text = text.replace(pattern, `${name}=${value}`);
  else text += `\n${name}=${value}`;
}
await writeFile(output, text.trimEnd() + '\n', { mode: 0o600 });
await chmod(output, 0o600);
await writeFile(new URL('./provisioning.json', import.meta.url), JSON.stringify({ organizationId: org.organization_id, siteId: site.site_id, otherSiteId: other.site_id, connectionId: connection.connection_id, evidence: 'simulation-only eligibility; not real provider verification' }, null, 2), { mode: 0o600 });
console.log('Dedicated local Sites provisioned. Server-side keys are in .env and were not printed. No workflow ran. Before using Sandbox, independently validate the real account and record its eligibility through the operator CLI.');
