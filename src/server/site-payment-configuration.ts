import { getBusinessPool } from "./database";

interface ConnectionRow {
  id: string;
  provider: "square" | "stripe";
  environment: "test" | "live";
  account_reference: string;
  location_reference: string | null;
  account_eligibility_status: "pending_validation" | "eligible" | "ineligible";
  platform_fee_eligibility_status: "pending_validation" | "eligible" | "ineligible";
  eligibility_validated_at: Date | null;
  eligibility_evidence_reference: string | null;
}

export interface PaymentConnectionData {
  connection_id: string;
  provider: "square" | "stripe";
  environment: "test" | "live";
  account_reference: string;
  location_reference: string | null;
  account_eligibility_status: "pending_validation" | "eligible" | "ineligible";
  platform_fee_eligibility_status: "pending_validation" | "eligible" | "ineligible";
  eligibility_validated_at: string | null;
  eligibility_evidence_reference: string | null;
}

function connectionData(row: ConnectionRow): PaymentConnectionData {
  return {
    connection_id: row.id,
    provider: row.provider,
    environment: row.environment,
    account_reference: row.account_reference,
    location_reference: row.location_reference,
    account_eligibility_status: row.account_eligibility_status,
    platform_fee_eligibility_status: row.platform_fee_eligibility_status,
    eligibility_validated_at: row.eligibility_validated_at?.toISOString() ?? null,
    eligibility_evidence_reference: row.eligibility_evidence_reference,
  };
}

const paymentConnectionSelect = `
  select connection.id, connection.provider, connection.environment,
         connection.account_reference, connection.location_reference,
         connection.account_eligibility_status, connection.platform_fee_eligibility_status,
         connection.eligibility_validated_at, connection.eligibility_evidence_reference
  from hpos.site_payment_connection_assignments assignment
  join hpos.payment_connections connection on connection.id = assignment.connection_id
  where assignment.site_id = $1
`;

async function readAssignedConnection(siteId: string, connectionId: string | null): Promise<ConnectionRow | null> {
  const assignmentFilter = connectionId === null
    ? "and assignment.unassigned_at is null"
    : "and connection.id = $2";
  const queryValues = connectionId === null ? [siteId] : [siteId, connectionId];
  const result = await getBusinessPool().query<ConnectionRow>(
    `${paymentConnectionSelect} ${assignmentFilter} order by assignment.assigned_at desc limit 1`,
    queryValues,
  );
  return result.rows[0] ?? null;
}

export async function readSitePaymentConfiguration(siteId: string): Promise<PaymentConnectionData | null> {
  const row = await readAssignedConnection(siteId, null);
  return row ? connectionData(row) : null;
}

export async function readSitePaymentConnection(siteId: string, connectionId: string): Promise<PaymentConnectionData | null> {
  const row = await readAssignedConnection(siteId, connectionId);
  return row ? connectionData(row) : null;
}

export function isPaymentConnectionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
