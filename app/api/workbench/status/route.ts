import { workbenchCatalog } from "@/src/workbench/catalog";
import { inspectLocalDatabase } from "@/src/workbench/database";
import { guardWorkbenchRequest } from "@/src/workbench/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guardWorkbenchRequest(request);
  if (denied) return denied;
  const database = await inspectLocalDatabase();
  return Response.json({
    application: { state: "ready", capability: "local foundation and testing workbench" },
    access: { state: "loopback-only", origin: process.env.HPOS_WORKBENCH_ORIGIN ?? "http://127.0.0.1:3000" },
    database,
    generatedDatabaseApi: { state: "disabled", reason: "The Supabase Data API is disabled; the workbench connects to PostgreSQL directly." },
    hposBusinessApi: { state: "unavailable", reason: "No /v1 business operations are implemented in this foundation slice.", siteKeyConfigured: Boolean(process.env.HPOS_SITE_API_KEY) },
    lmnlIntegration: { state: "unavailable", reason: "A local LMNL backend is not part of this repository yet." },
    environment: "local",
    dataset: "local-foundation-empty",
    revision: process.env.HPOS_REVISION ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown",
    catalogue: workbenchCatalog,
  });
}
