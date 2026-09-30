import { apiFailure, apiSuccess } from "@/src/server/api-response";
import { authenticateSiteRequest } from "@/src/server/site-auth";
import { isPaymentConnectionId, readSitePaymentConfiguration, readSitePaymentConnection } from "@/src/server/site-payment-configuration";
import { handleNotificationGet, handleNotificationPost } from "@/src/server/notifications";
import { handleCheckoutPost } from "@/src/server/checkout";
import { handleEventActionPost, handleEventGet, handleEventPatch, handleEventPost } from "@/src/server/events";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

export async function GET(request: Request, context: RouteContext) {
  const authentication = await authenticateSiteRequest(request);
  if (authentication.error) return authentication.error;
  const { path } = await context.params;

  try {
    const eventResponse = await handleEventGet(request, authentication.site, path);
    if (eventResponse) return eventResponse;

    const notificationResponse = await handleNotificationGet(request, authentication.site, path);
    if (notificationResponse) return notificationResponse;

    if (path.length === 2 && path[0] === "admin" && path[1] === "payment-configuration") {
      const connection = await readSitePaymentConfiguration(authentication.site.siteId);
      return apiSuccess({ active_connection: connection });
    }

    if (path.length === 3 && path[0] === "admin" && path[1] === "payment-connections") {
      if (!isPaymentConnectionId(path[2])) {
        return apiFailure(404, "not_found", "The payment connection is not available to this Site.");
      }
      const connection = await readSitePaymentConnection(authentication.site.siteId, path[2]);
      if (!connection) return apiFailure(404, "not_found", "The payment connection is not available to this Site.");
      return apiSuccess(connection);
    }

    return apiFailure(404, "not_found", "The requested API operation is unavailable.");
  } catch {
    return apiFailure(503, "service_unavailable", "The requested API operation is temporarily unavailable.", { retryAfter: 1 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const authentication = await authenticateSiteRequest(request);
  if (authentication.error) return authentication.error;
  const { path } = await context.params;

  try {
    const checkoutResponse = await handleCheckoutPost(request, authentication.site, path);
    if (checkoutResponse) return checkoutResponse;

    const eventResponse = await handleEventPost(request, authentication.site, path)
      ?? await handleEventActionPost(request, authentication.site, path);
    if (eventResponse) return eventResponse;

    const notificationResponse = await handleNotificationPost(request, authentication.site, path);
    return notificationResponse ?? apiFailure(404, "not_found", "The requested API operation is unavailable.");
  } catch {
    return apiFailure(503, "service_unavailable", "The requested API operation is temporarily unavailable.", { retryAfter: 1 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const authentication = await authenticateSiteRequest(request);
  if (authentication.error) return authentication.error;
  const { path } = await context.params;

  try {
    const eventResponse = await handleEventPatch(request, authentication.site, path);
    return eventResponse ?? apiFailure(404, "not_found", "The requested API operation is unavailable.");
  } catch {
    return apiFailure(503, "service_unavailable", "The requested API operation is temporarily unavailable.", { retryAfter: 1 });
  }
}
