import { createHash } from 'node:crypto';

export function loadConfig(env = process.env) {
  const docker = env.TEST_SITE_CONTAINER === 'true';
  const hostNetwork = docker && env.TEST_SITE_HOST_NETWORK === 'true';
  const origin = new URL(env.HPOS_ORIGIN || 'http://127.0.0.1:3000');
  const hosts = hostNetwork ? ['127.0.0.1'] : docker ? ['host.docker.internal', 'hpos'] : ['127.0.0.1'];
  if (origin.protocol !== 'http:' || !hosts.includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !/^3\d{3}$/.test(origin.port)) {
    throw new Error('HPOS_ORIGIN must be a local HTTP origin on port 3000–3999. Containers accept only host.docker.internal or the hpos Docker service; host execution accepts only 127.0.0.1.');
  }
  const port = Number(env.TEST_SITE_PORT || 3100);
  if (!Number.isInteger(port) || port < 3000 || port > 3999) throw new Error('TEST_SITE_PORT must be 3000–3999.');
  const config = {
    origin: origin.origin, port, bind: docker && !hostNetwork ? '0.0.0.0' : '127.0.0.1', docker,
    siteKey: env.HPOS_SITE_API_KEY || '', otherSiteKey: env.HPOS_OTHER_SITE_API_KEY || '',
    siteId: env.HPOS_SITE_ID || '', connectionId: env.HPOS_CONNECTION_ID || '',
    cronSecret: env.CRON_SECRET || '', squareToken: env.SQUARE_SANDBOX_ACCESS_TOKEN || '',
    squareLocation: env.SQUARE_SANDBOX_LOCATION_ID || '',
    squareAccountAlias: env.SQUARE_ACCOUNT_ALIAS || 'ref:fake-lmnl-square',
    squareLocationAlias: env.SQUARE_LOCATION_ALIAS || 'ref:fake-lmnl-location',
    resendKey: env.RESEND_API_KEY || '', resendFrom: env.RESEND_FROM || '', operatorEmail: env.OPERATOR_EMAIL || '',
  };
  config.fingerprint = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  return config;
}
export function blockers(workflow, profile, config) {
  if (!['simulation', 'sandbox'].includes(profile)) return ['Unknown profile.'];
  if (!workflow.profiles.includes(profile)) return ['This workflow supports simulation only.'];
  const result = [];
  if (!config.siteKey || !config.siteId || !config.connectionId) result.push('Dedicated local Site configuration is missing. Run npm run setup on the host, then start Docker Compose.');
  if (workflow.otherSite && !config.otherSiteKey) result.push('A secondary local Site key is required for isolation.');
  if (profile === 'sandbox') {
    if (!config.squareToken || !config.squareLocation) result.push('Square Sandbox token/location are missing.');
    if (!config.resendKey || !config.resendFrom || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.operatorEmail)) result.push('Resend sending configuration and an operator-owned recipient are required.');
  }
  return result;
}
