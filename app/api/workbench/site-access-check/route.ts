import { runSiteAccessConfigurationCheck } from "@/src/server/site-access-check";
import { inspectLocalDatabase } from "@/src/workbench/database";
import { guardWorkbenchRequest } from "@/src/workbench/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = guardWorkbenchRequest(request, true);
  if (denied) return denied;

  const database = await inspectLocalDatabase();
  if (!database.ready) return Response.json({ error: database.message }, { status: 503 });

  try {
    const result = await runSiteAccessConfigurationCheck();
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "The Site access check could not complete. Review local service status and the latest workbench history." }, { status: 503 });
  }
}
