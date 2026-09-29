import { inspectLocalDatabase, readAllHistory } from "@/src/workbench/database";
import { guardWorkbenchRequest } from "@/src/workbench/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guardWorkbenchRequest(request);
  if (denied) return denied;
  const database = await inspectLocalDatabase();
  if (!database.ready) return Response.json({ error: database.message }, { status: 503 });
  try {
    const exportDocument = {
      format: "hpos-local-workbench-export/v1",
      exportedAt: new Date().toISOString(),
      environment: "local",
      dataset: "local-foundation-empty",
      revision: process.env.HPOS_REVISION ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown",
      records: await readAllHistory(),
    };
    return new Response(JSON.stringify(exportDocument, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="hpos-workbench-history.json"', "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "History storage is unavailable." }, { status: 503 });
  }
}
