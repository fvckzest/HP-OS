import { handleScheduledProcessing } from "@/server/notification-processing";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleScheduledProcessing(request);
}
