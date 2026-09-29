import { apiFailure, apiSuccess } from "@/src/server/api-response";
import { getBusinessPool } from "@/src/server/database";
import { authenticateSiteRequest } from "@/src/server/site-auth";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

interface ConnectionRow {
  id: string;
  provider: "square" | "stripe";
  environment: "test" | "live";
  account_reference: string;
  location_reference: string | null;
}

function connectionData(row: ConnectionRow) {
  return {
    connection_id: row.id,
    provider: row.provider,
    environment: row.environment,
    account_reference: row.account_reference,
    location_reference: row.location_reference,
  };
}

export async function GET(request: Request, context: RouteContext) {
  const authentication = await authenticateSiteRequest(request);
  if (authentication.error) return authentication.error;
  const { path } = await context.params;
  const pool = getBusinessPool();

  try {
    if (path.length === 2 && path[0] === "admin" && path[1] === "payment-configuration") {
      const result = await pool.query<ConnectionRow>(
        `select connection.id, connection.provider, connection.environment,
                connection.account_reference, connection.location_reference
         from hpos.site_payment_connection_assignments assignment
         join hpos.payment_connections connection on connection.id = assignment.connection_id
         where assignment.site_id = $1 and assignment.unassigned_at is null
         limit 1`,
        [authentication.site.siteId],
      );
      return apiSuccess({ active_connection: result.rows[0] ? connectionData(result.rows[0]) : null });
    }

    if (path.length === 3 && path[0] === "admin" && path[1] === "payment-connections") {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(path[2])) {
        return apiFailure(404, "not_found", "The payment connection is not available to this Site.");
      }
      const result = await pool.query<ConnectionRow>(
        `select connection.id, connection.provider, connection.environment,
                connection.account_reference, connection.location_reference
         from hpos.site_payment_connection_assignments assignment
         join hpos.payment_connections connection on connection.id = assignment.connection_id
         where assignment.site_id = $1 and connection.id = $2
         order by assignment.assigned_at desc
         limit 1`,
        [authentication.site.siteId, path[2]],
      );
      if (!result.rows[0]) return apiFailure(404, "not_found", "The payment connection is not available to this Site.");
      return apiSuccess(connectionData(result.rows[0]));
    }

    return apiFailure(404, "not_found", "The requested API operation is unavailable.");
  } catch {
    return apiFailure(503, "service_unavailable", "Payment configuration is temporarily unavailable.", { retryAfter: 1 });
  }
}
