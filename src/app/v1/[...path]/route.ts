import { apiFailure, apiSuccess } from "@/server/api-response";
import { authenticateSiteRequest } from "@/server/site-auth";
import { isPaymentConnectionId, readSitePaymentConfiguration, readSitePaymentConnection } from "@/server/site-payment-configuration";
import { handleNotificationGet, handleNotificationPost } from "@/server/notifications";
import { handleCheckoutPost } from "@/server/checkout";
import { handlePaymentAttemptGet, handlePaymentAttemptPost } from "@/server/payment-attempts";
import { handleAdminOrderActionPost, handleAdminOrderGet, handleAdminOrderPaymentStatusGet, handleBuyerOrderGet, handleBuyerTicketGet } from "@/server/ticket-issuance";
import { handlePaymentInvestigationGet, handlePaymentReportPost, handlePaymentResolutionPost } from "@/server/payment-reports";
import { handleEventActionPost, handleEventGet, handleEventPatch, handleEventPost } from "@/server/events";
import { handleAdmissionPost } from "@/server/admissions";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

export async function GET(request: Request, context: RouteContext) {
  const authentication = await authenticateSiteRequest(request);
  if (authentication.error) return authentication.error;
  const { path } = await context.params;

  try {
    const buyerOrderResponse = await handleBuyerOrderGet(authentication.site, path);
    if (buyerOrderResponse) return buyerOrderResponse;

    const buyerTicketResponse = await handleBuyerTicketGet(authentication.site, path);
    if (buyerTicketResponse) return buyerTicketResponse;

    const orderStatusResponse = await handleAdminOrderPaymentStatusGet(authentication.site, path);
    if (orderStatusResponse) return orderStatusResponse;

    const adminOrderResponse = await handleAdminOrderGet(authentication.site, path);
    if (adminOrderResponse) return adminOrderResponse;

    const eventResponse = await handleEventGet(request, authentication.site, path);
    if (eventResponse) return eventResponse;

    const notificationResponse = await handleNotificationGet(request, authentication.site, path);
    if (notificationResponse) return notificationResponse;

    const paymentInvestigationResponse = await handlePaymentInvestigationGet(request, authentication.site, path);
    if (paymentInvestigationResponse) return paymentInvestigationResponse;

    const paymentAttemptResponse = await handlePaymentAttemptGet(request, authentication.site, path);
    if (paymentAttemptResponse) return paymentAttemptResponse;

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
    const admissionResponse = await handleAdmissionPost(request, authentication.site, path);
    if (admissionResponse) return admissionResponse;

    const paymentResolutionResponse = await handlePaymentResolutionPost(request, authentication.site, path);
    if (paymentResolutionResponse) return paymentResolutionResponse;

    const adminOrderActionResponse = await handleAdminOrderActionPost(request, authentication.site, path);
    if (adminOrderActionResponse) return adminOrderActionResponse;

    const paymentReportResponse = await handlePaymentReportPost(request, authentication.site, path);
    if (paymentReportResponse) return paymentReportResponse;

    const paymentAttemptResponse = await handlePaymentAttemptPost(request, authentication.site, path);
    if (paymentAttemptResponse) return paymentAttemptResponse;

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
