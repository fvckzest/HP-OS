import { workbenchCatalog } from "@/src/workbench/catalog";
import { inspectLocalDatabase } from "@/src/workbench/database";
import { guardWorkbenchRequest } from "@/src/workbench/http";
import { inspectSiteAccessSchema } from "@/src/server/site-access-status";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guardWorkbenchRequest(request);
  if (denied) return denied;
  const database = await inspectLocalDatabase();
  const siteAccess = database.ready ? await inspectSiteAccessSchema() : { ready: false, message: database.message };
  const catalogue = workbenchCatalog.map((entry) => entry.id === "site-payment-configuration" && !siteAccess.ready
    ? { ...entry, availability: "blocked" as const, prerequisite: siteAccess.message }
    : entry);
  return Response.json({
    application: { state: "ready", capability: "Site access, payment configuration reads, and local testing workbench" },
    access: { state: "loopback-only", origin: process.env.HPOS_WORKBENCH_ORIGIN ?? "http://127.0.0.1:3000" },
    database,
    generatedDatabaseApi: { state: "disabled", reason: "The Supabase Data API is disabled; the workbench connects to PostgreSQL directly." },
    hposBusinessApi: { state: siteAccess.ready ? "available" : "blocked", reason: `${siteAccess.message} Events and ticketing operations remain unavailable.`, siteKeyConfigured: Boolean(process.env.HPOS_SITE_API_KEY) },
    lmnlIntegration: { state: "unavailable", reason: "A local LMNL backend is not part of this repository yet." },
    environment: "local",
    dataset: "local-foundation-empty",
    revision: process.env.HPOS_REVISION ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown",
    catalogue,
  });
}
