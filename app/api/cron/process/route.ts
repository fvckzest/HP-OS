import { handleScheduledProcessing } from "@/src/server/notifications";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleScheduledProcessing(request);
}
