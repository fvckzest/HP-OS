import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";

type OperatorOptions = Record<string, string>;
interface SiteKey { id: string; key: string; hash: string }

const LOCAL_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const databaseUrl = process.env.HPOS_DATABASE_URL ?? LOCAL_DATABASE_URL;

function fail(message: string): never {
  throw new Error(message);
}

function isLocalDatabase(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "postgresql:" && url.hostname === "127.0.0.1" && url.port === "54322" && url.username === "postgres" && url.pathname === "/postgres";
  } catch {
    return false;
  }
}

if (!isLocalDatabase(databaseUrl) && process.env.HPOS_OPERATOR_ALLOW_REMOTE !== "true") {
  fail("Remote operator access is disabled. Set HPOS_OPERATOR_ALLOW_REMOTE=true only in an approved operator environment.");
}

function readOptions(args: string[]): OperatorOptions {
  const options: OperatorOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name.startsWith("--") || !args[index + 1] || args[index + 1].startsWith("--")) fail(`Expected a value after ${name}.`);
    options[name.slice(2)] = args[index + 1];
    index += 1;
  }
  return options;
}

function required(options: OperatorOptions, name: string): string {
  const value = options[name]?.trim();
  if (!value) fail(`Provide --${name}.`);
  return value;
}

function uuid(value: string, flag: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail(`--${flag} must be a UUID.`);
  return value;
}

function boundedName(value: string, flag: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 200) fail(`--${flag} must contain 1 to 200 characters.`);
  return trimmed;
}

function referenceAlias(value: string, flag: string): string {
  const trimmed = value.trim();
  if (!/^ref:[A-Za-z0-9][A-Za-z0-9._:-]{0,245}$/.test(trimmed)) {
    fail(`--${flag} must be a non-secret reference alias starting with ref: and using only letters, numbers, period, underscore, colon, or hyphen.`);
  }
  return trimmed;
}

async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function newSiteKey(): SiteKey {
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const key = `hpos_site_${id}_${secret}`;
  const hash = createHash("sha256").update(key, "utf8").digest("hex");
  return { id, key, hash };
}

const help = `HP-OS operator setup (database changes are direct operator actions; no customer onboarding UI is created)

  pnpm operator organization create --name "LMNL"
  pnpm operator site create --organization <organization-id> --name "LMNL main"
  pnpm operator payment-connection create --organization <organization-id> --provider square --environment test --account-reference ref:venue-square [--location-reference ref:main-hall]
  pnpm operator site assign-connection --site <site-id> --connection <connection-id>
  pnpm operator site request-limit --site <site-id> --per-minute 1200
  pnpm operator organization fee-terms-pending --organization <organization-id>
  pnpm operator site-key issue --site <site-id>
  pnpm operator site-key rotate --site <site-id>
  pnpm operator site-key revoke --site <site-id> --key-id <key-id>
  pnpm operator site-key revoke --site <site-id> --all true

Keys have 256 bits of random secret material. The command displays a key only once; copy it directly to the Site backend's secret store. Rotation revokes all previous keys before issuing the replacement. `;

const [group, action, ...rest] = process.argv.slice(2);
if (!group || group === "help" || group === "--help") {
  console.log(help);
  process.exit(0);
}

const options = readOptions(rest);
const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });

try {
  if (group === "organization" && action === "create") {
    const name = boundedName(required(options, "name"), "name");
    const result = await pool.query<{ id: string }>(`insert into hpos.organizations (name) values ($1) returning id`, [name]);
    console.log(JSON.stringify({ organization_id: result.rows[0].id, fee_terms_status: "pending_validation" }));
  } else if (group === "site" && action === "create") {
    const organizationId = uuid(required(options, "organization"), "organization");
    const name = boundedName(required(options, "name"), "name");
    const result = await pool.query<{ id: string }>(`insert into hpos.sites (organization_id, name) values ($1, $2) returning id`, [organizationId, name]);
    console.log(JSON.stringify({ site_id: result.rows[0].id, organization_id: organizationId, request_limit_per_minute: 1200 }));
  } else if (group === "payment-connection" && action === "create") {
    const organizationId = uuid(required(options, "organization"), "organization");
    const provider = required(options, "provider");
    const environment = required(options, "environment");
    if (!new Set<string>(["square", "stripe"]).has(provider)) fail("--provider must be square or stripe.");
    if (!new Set<string>(["test", "live"]).has(environment)) fail("--environment must be test or live.");
    const accountReference = referenceAlias(required(options, "account-reference"), "account-reference");
    const locationReference = options["location-reference"] ? referenceAlias(options["location-reference"], "location-reference") : null;
    const result = await pool.query<{ id: string }>(
      `insert into hpos.payment_connections (organization_id, provider, environment, account_reference, location_reference)
       values ($1, $2, $3, $4, $5) returning id`,
      [organizationId, provider, environment, accountReference, locationReference],
    );
    console.log(JSON.stringify({ connection_id: result.rows[0].id, organization_id: organizationId, provider, environment, account_eligibility_status: "pending_validation" }));
  } else if (group === "site" && action === "assign-connection") {
    const siteId = uuid(required(options, "site"), "site");
    const connectionId = uuid(required(options, "connection"), "connection");
    await transaction(pool, async (client) => {
      const ownership = await client.query<{ site_organization_id: string; connection_organization_id: string }>(
        `select site.organization_id as site_organization_id, connection.organization_id as connection_organization_id
         from hpos.sites site cross join hpos.payment_connections connection
         where site.id = $1 and connection.id = $2`,
        [siteId, connectionId],
      );
      const row = ownership.rows[0];
      if (!row) fail("The Site or payment connection does not exist.");
      if (row.site_organization_id !== row.connection_organization_id) fail("A payment connection can only be assigned to a Site in the same organization.");
      const current = await client.query<{ connection_id: string }>(
        `select connection_id from hpos.site_payment_connection_assignments where site_id = $1 and unassigned_at is null`,
        [siteId],
      );
      if (current.rows[0]?.connection_id === connectionId) return;
      await client.query(`update hpos.site_payment_connection_assignments set unassigned_at = clock_timestamp() where site_id = $1 and unassigned_at is null`, [siteId]);
      await client.query(
        `insert into hpos.site_payment_connection_assignments (site_id, organization_id, connection_id)
         values ($1, $2, $3)`,
        [siteId, row.site_organization_id, connectionId],
      );
    });
    console.log(JSON.stringify({ site_id: siteId, connection_id: connectionId, assignment: "active" }));
  } else if (group === "site" && action === "request-limit") {
    const siteId = uuid(required(options, "site"), "site");
    const perMinute = Number(required(options, "per-minute"));
    if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 10_000_000) fail("--per-minute must be an integer from 1 to 10000000.");
    const result = await pool.query(`update hpos.sites set request_limit_per_minute = $2 where id = $1 returning id`, [siteId, perMinute]);
    if (result.rowCount !== 1) fail("The Site does not exist.");
    console.log(JSON.stringify({ site_id: siteId, request_limit_per_minute: perMinute }));
  } else if (group === "organization" && action === "fee-terms-pending") {
    const organizationId = uuid(required(options, "organization"), "organization");
    const result = await pool.query(`update hpos.organizations set fee_terms_status = 'pending_validation' where id = $1 returning id`, [organizationId]);
    if (result.rowCount !== 1) fail("The organization does not exist.");
    console.log(JSON.stringify({ organization_id: organizationId, fee_terms_status: "pending_validation" }));
  } else if (group === "site-key" && ["issue", "rotate", "revoke"].includes(action)) {
    const siteId = uuid(required(options, "site"), "site");
    if (action === "revoke") {
      const revokeAll = options.all === "true";
      const keyId = options["key-id"] ? uuid(options["key-id"], "key-id") : null;
      if (!revokeAll && !keyId) fail("Provide --key-id <uuid> or --all true.");
      const result = await pool.query<{ id: string }>(
        `update hpos.site_api_keys set revoked_at = clock_timestamp()
         where site_id = $1 and revoked_at is null and ($2::boolean or id = $3::uuid)
         returning id`,
        [siteId, revokeAll, keyId],
      );
      if (result.rowCount === 0) fail("No active Site API key matched the requested revocation.");
      console.log(JSON.stringify({ site_id: siteId, revoked_key_ids: result.rows.map((row) => row.id) }));
    } else {
      const newKey = newSiteKey();
      await transaction(pool, async (client) => {
        const site = await client.query<{ id: string }>(`select id from hpos.sites where id = $1 for update`, [siteId]);
        if (site.rowCount !== 1) fail("The Site does not exist.");
        if (action === "rotate") await client.query(`update hpos.site_api_keys set revoked_at = clock_timestamp() where site_id = $1 and revoked_at is null`, [siteId]);
        await client.query(`insert into hpos.site_api_keys (id, site_id, key_hash) values ($1, $2, $3)`, [newKey.id, siteId, newKey.hash]);
      });
      console.log(JSON.stringify({ site_id: siteId, key_id: newKey.id, site_api_key: newKey.key, operation: action }));
    }
  } else {
    fail("Unknown operator command. Run `pnpm operator help` for the supported commands.");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "The operator command failed.";
  console.error(`HP-OS operator command failed: ${message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
