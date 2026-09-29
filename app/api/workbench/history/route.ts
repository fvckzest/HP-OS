import { clearHistory, inspectLocalDatabase, readHistory } from "@/src/workbench/database";
import { guardWorkbenchRequest } from "@/src/workbench/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guardWorkbenchRequest(request);
  if (denied) return denied;
  const database = await inspectLocalDatabase();
  if (!database.ready) return Response.json({ error: database.message }, { status: 503 });
  try {
    return Response.json(await readHistory());
  } catch {
    return Response.json({ error: "History storage is unavailable." }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const denied = guardWorkbenchRequest(request, true);
  if (denied) return denied;
  const database = await inspectLocalDatabase();
  if (!database.ready) return Response.json({ error: database.message }, { status: 503 });
  try {
    const deleted = await clearHistory();
    return Response.json({ deleted, message: "Diagnostic history cleared. Business records were not changed." });
  } catch {
    return Response.json({ error: "History storage is unavailable." }, { status: 503 });
  }
}
