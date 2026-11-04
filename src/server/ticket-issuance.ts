/**
 * Compatibility facade for the Ticketing API.
 *
 * Route handlers import the bounded capability modules directly; this facade
 * keeps existing server-side callers stable while the module boundaries settle.
 */
export { issuePaidOrder, processPendingTicketIssuance } from "./ticket-issuance-service";
export { handleBuyerOrderGet, handleBuyerTicketGet } from "./buyer-access";
export { handleAdminOrderGet, handleAdminOrderPaymentStatusGet, readAdminOrder } from "./admin-order";
export { handleAdminOrderActionPost } from "./ticket-recovery";
