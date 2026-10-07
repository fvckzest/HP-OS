import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { apiFailure } from "./api-response";
import { ApiOperationError, withApiIdempotency } from "./api-idempotency";
import type { IdempotentResult } from "./api-idempotency";
import { getBusinessPool } from "./database";
import { salesStatus } from "./events";
import type { EventSalesState } from "./events";
import type { AuthenticatedSite } from "./site-auth";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PUBLIC_QUANTITY = 8;
const MAX_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);

interface Fee {
  code: string;
  label: string;
  amount: number;
  currency: string;
}

interface PricingRow extends QueryResultRow, EventSalesState {
  id: string;
  site_id: string;
  ticket_offering_id: string;
  title: string | null;
  publication_status: "draft" | "published";
  is_archived: boolean;
  visibility: "public" | "private" | null;
  currency: string | null;
  tax_amount: string | null;
  buyer_fees: Fee[] | null;
  platform_fee_basis_points: number | null;
  fee_terms_status: "pending_validation" | "configured";
}

interface QuoteRow extends QueryResultRow {
  id: string;
  site_id: string;
  event_id: string;
  offering_id: string;
  quantity: number;
  currency: string;
  unit_price: string;
  subtotal: string;
  buyer_fees: Fee[];
  tax_total: string;
  total: string;
  platform_fee_basis_points: number;
  platform_fee_amount: string;
  expires_at: Date;
  access_request_id: string | null;
  approval_token_id: string | null;
}

interface ApprovedAccessRow extends QueryResultRow {
  id: string;
  event_id: string;
  name: string;
  email: string;
  status: "pending" | "approved" | "rejected";
  paid_order_id: string | null;
  token_id: string;
  token_revoked_at: Date | null;
}

interface PaymentConnectionRow extends QueryResultRow {
  id: string;
  provider: "square" | "stripe";
  environment: "test" | "live";
  account_reference: string;
  location_reference: string | null;
  account_eligibility_status: "pending_validation" | "eligible" | "ineligible";
  platform_fee_eligibility_status: "pending_validation" | "eligible" | "ineligible";
  provider_mapping: Record<string, unknown> | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function fieldError(field: string, code: string, message: string): Response {
  return apiFailure(422, "validation_failed", message, { details: [{ field, code, message }] });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return apiFailure(415, "unsupported_media_type", "Send checkout fields as application/json.");
  }
  let text: string;
  try { text = await request.text(); }
  catch { return apiFailure(400, "invalid_request", "The request body could not be read as JSON."); }
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return apiFailure(413, "request_too_large", "The request body exceeds 64 KiB.");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return apiFailure(400, "invalid_request", "The request body must contain readable JSON."); }
  if (!object(value)) return apiFailure(400, "invalid_request", "The request body must be a JSON object.");
  return value;
}

function operationError(status: number, code: string, message: string, details: Array<{ field: string; code: string; message: string }> = []): never {
  throw new ApiOperationError(status, code, message, details);
}

function addSafeAmounts(...amounts: Array<number | string>): number {
  const sum = amounts.reduce((total, amount) => total + BigInt(amount), 0n);
  if (sum < 0n || sum > MAX_AMOUNT) operationError(503, "payment_configuration_unavailable", "The configured checkout total is outside the supported amount range.");
  return Number(sum);
}

function multiplySafeAmount(amount: number | string, quantity: number): number {
  const product = BigInt(amount) * BigInt(quantity);
  if (product < 0n || product > MAX_AMOUNT) operationError(503, "payment_configuration_unavailable", "The configured checkout total is outside the supported amount range.");
  return Number(product);
}

function feeAmount(subtotal: number, basisPoints: number): number {
  const rounded = (BigInt(subtotal) * BigInt(basisPoints) + 5000n) / 10000n;
  if (rounded > MAX_AMOUNT) operationError(503, "payment_configuration_unavailable", "The configured platform fee is outside the supported amount range.");
  return Number(rounded);
}

function insufficientCapacity(available: number): never {
  if (available <= 0) operationError(409, "sold_out", "No Tickets remain available for this Event.");
  operationError(409, "insufficient_capacity", "The requested Ticket quantity exceeds the Event's current availability.");
}

function money(amount: number | string, currency: string) {
  return { amount: Number(amount), currency };
}

function quoteData(row: QuoteRow) {
  return {
    quote_id: row.id,
    event_id: row.event_id,
    quantity: row.quantity,
    unit_price: money(row.unit_price, row.currency),
    subtotal: money(row.subtotal, row.currency),
    buyer_fees: row.buyer_fees,
    tax_total: money(row.tax_total, row.currency),
    total: money(row.total, row.currency),
    platform_fee: money(row.platform_fee_amount, row.currency),
    platform_fee_basis_points: row.platform_fee_basis_points,
    expires_at: row.expires_at.toISOString(),
  };
}

function mapCheckoutDatabaseError(error: unknown): Response | null {
  if (object(error) && error.code === "23514") return apiFailure(422, "validation_failed", "The checkout request violates a configured field constraint.");
  if (object(error) && error.code === "23503") return apiFailure(409, "invalid_state", "The Event or checkout configuration is no longer available.");
  if (object(error) && error.code === "23505") {
    if (error.constraint === "orders_one_private_active_checkout_idx") {
      return apiFailure(409, "access_checkout_in_progress", "This approval already has an active or unresolved checkout.");
    }
    if (error.constraint === "orders_one_private_consumed_purchase_idx") {
      return apiFailure(409, "access_already_used", "This approval has already produced a purchase.");
    }
    if (error.constraint === "orders_quote_id_key") {
      return apiFailure(409, "quote_already_used", "This quote has already created an Order. Request a new quote for another checkout.");
    }
  }
  return null;
}

async function lockedPricing(client: PoolClient, siteId: string, eventId: string): Promise<PricingRow> {
  const result = await client.query<PricingRow>(
    `select e.id, e.site_id, e.ticket_offering_id, e.title, e.publication_status,
            e.visibility, e.is_canceled, e.is_archived, e.sales_paused, e.ends_at,
            o.price_amount, o.currency, o.tax_amount, o.buyer_fees, o.capacity,
            o.reserved_quantity, o.sales_opens_at, o.sales_closes_at,
            organization.platform_fee_basis_points, organization.fee_terms_status
     from hpos.events e
     join hpos.ticket_offerings o
       on o.id = e.ticket_offering_id and o.event_id = e.id and o.site_id = e.site_id
     join hpos.sites site on site.id = e.site_id
     join hpos.organizations organization on organization.id = site.organization_id
     where e.site_id = $1 and e.id = $2
     for update of e, o, organization`,
    [siteId, eventId],
  );
  const row = result.rows[0];
  if (!row) operationError(404, "not_found", "The Event is not available to this Site.");
  return row;
}

function assertPublicSalesOpen(row: PricingRow): void {
  if (row.publication_status !== "published" || row.is_archived || row.visibility !== "public") {
    if (row.visibility === "private") operationError(409, "access_request_required", "This Event requires an approved Access Request before checkout.");
    operationError(404, "not_found", "The Event is not available for public checkout.");
  }
  const status = salesStatus(row);
  if (status === "not_configured") operationError(409, "sales_not_configured", "This Event is not configured for checkout.");
  if (status === "sold_out") operationError(409, "sold_out", "No Tickets remain available for this Event.");
  if (status === "paused") operationError(409, "sales_paused", "Sales for this Event are temporarily stopped.");
  if (status === "scheduled") operationError(409, "sales_not_open", "Sales for this Event have not opened yet.");
  if (status === "closed" || status === "canceled") operationError(409, "sales_closed", "Sales for this Event are closed.");
}

function assertPrivateSalesOpen(row: PricingRow): void {
  if (row.publication_status !== "published" || row.is_archived || row.visibility !== "private") {
    operationError(404, "not_found", "The Event is not available for private checkout.");
  }
  const status = salesStatus(row);
  if (status === "not_configured") operationError(409, "sales_not_configured", "This Event is not configured for checkout.");
  if (status === "sold_out") operationError(409, "sold_out", "No Tickets remain available for this Event.");
  if (status === "paused") operationError(409, "sales_paused", "Sales for this Event are temporarily stopped.");
  if (status === "scheduled") operationError(409, "sales_not_open", "Sales for this Event have not opened yet.");
  if (status === "closed" || status === "canceled") operationError(409, "sales_closed", "Sales for this Event are closed.");
}

function approvalTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function lockedApprovedAccess(
  client: PoolClient,
  siteId: string,
  eventId: string,
  token: string,
): Promise<ApprovedAccessRow> {
  const result = await client.query<ApprovedAccessRow>(
    `select request.id, request.event_id, request.name, request.email,
            request.status, request.paid_order_id,
            token.id as token_id, token.revoked_at as token_revoked_at
     from hpos.access_request_approval_tokens token
     join hpos.access_requests request
       on request.id = token.access_request_id and request.site_id = token.site_id
     where token.site_id = $1 and token.token_hash = $2 and request.event_id = $3
     for update of request, token`,
    [siteId, approvalTokenHash(token), eventId],
  );
  const access = result.rows[0];
  if (!access || access.token_revoked_at || access.status !== "approved") {
    operationError(404, "not_found", "The approval link is not available to this Site.");
  }
  if (access.paid_order_id) operationError(409, "access_already_used", "This approval has already produced a purchase.");
  return access;
}

function validatedPricing(row: PricingRow, quantity: number) {
  if (row.platform_fee_basis_points === null || row.fee_terms_status !== "configured") {
    operationError(503, "payment_configuration_unavailable", "The Organization platform-fee terms are not configured.");
  }
  if (row.price_amount === null || !row.currency || row.tax_amount === null || row.buyer_fees === null) {
    operationError(503, "payment_configuration_unavailable", "Tax and buyer-fee inputs must be explicitly configured before checkout.");
  }
  const price = Number(row.price_amount);
  const tax = Number(row.tax_amount);
  if (!Number.isSafeInteger(price) || !Number.isSafeInteger(tax)) {
    operationError(503, "payment_configuration_unavailable", "Configured price or tax is outside the supported amount range.");
  }
  for (const fee of row.buyer_fees) {
    if (!fee || typeof fee.code !== "string" || typeof fee.label !== "string"
      || !Number.isSafeInteger(fee.amount) || fee.amount < 0 || fee.currency !== row.currency) {
      operationError(503, "payment_configuration_unavailable", "Buyer-fee configuration is invalid or uses a different currency from the Ticket.");
    }
  }
  const subtotal = multiplySafeAmount(price, quantity);
  const buyerFees = row.buyer_fees.map((fee) => ({
    ...fee,
    amount: multiplySafeAmount(fee.amount, quantity),
  }));
  const feesTotal = addSafeAmounts(...buyerFees.map((fee) => fee.amount));
  const taxTotal = multiplySafeAmount(tax, quantity);
  const total = addSafeAmounts(subtotal, feesTotal, taxTotal);
  const platformFee = feeAmount(subtotal, Number(row.platform_fee_basis_points));
  return { currency: row.currency, price, subtotal, buyerFees, tax: taxTotal, total, platformFee, feeRate: Number(row.platform_fee_basis_points) };
}

async function createQuote(
  client: PoolClient,
  site: AuthenticatedSite,
  eventId: string,
  quantity: number,
  accessRequestToken: string | null = null,
): Promise<IdempotentResult> {
  const row = await lockedPricing(client, site.siteId, eventId);
  if (accessRequestToken && row.visibility === "public") {
    operationError(409, "access_not_required", "This Event accepts public checkout instead of an approval token.");
  }
  const access = accessRequestToken
    ? await lockedApprovedAccess(client, site.siteId, eventId, accessRequestToken)
    : null;
  if (access && quantity !== 1) {
    operationError(422, "validation_failed", "Private checkout supports exactly one Ticket per Order.", [
      { field: "quantity", code: "unsupported_quantity", message: "Private checkout supports exactly one Ticket per Order." },
    ]);
  }
  if (access) assertPrivateSalesOpen(row);
  else if (row.visibility === "private") operationError(404, "not_found", "The approval link is not available to this Site.");
  else assertPublicSalesOpen(row);
  const available = Number(row.capacity) - Number(row.reserved_quantity);
  if (available < quantity) insufficientCapacity(available);
  const pricing = validatedPricing(row, quantity);
  const quoteId = randomUUID();
  const inserted = await client.query<QuoteRow>(
    `insert into hpos.public_quotes (
       id, site_id, event_id, offering_id, quantity, currency, unit_price, subtotal,
       buyer_fees, tax_total, total, platform_fee_basis_points, platform_fee_amount,
       expires_at, access_request_id, approval_token_id
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13,
       clock_timestamp() + interval '10 minutes', $14, $15
     )
     returning id, site_id, event_id, offering_id, quantity, currency, unit_price,
       subtotal, buyer_fees, tax_total, total, platform_fee_basis_points,
       platform_fee_amount, expires_at, access_request_id, approval_token_id`,
    [quoteId, site.siteId, eventId, row.ticket_offering_id, quantity, pricing.currency, pricing.price,
      pricing.subtotal, JSON.stringify(pricing.buyerFees), pricing.tax, pricing.total,
      pricing.feeRate, pricing.platformFee, access?.id ?? null, access?.token_id ?? null],
  );
  return { status: 201, data: quoteData(inserted.rows[0]) };
}

function parseApprovalToken(value: unknown): string | Response | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 512) {
    return apiFailure(404, "not_found", "The approval link is not available to this Site.");
  }
  return value;
}

function parseQuoteRequest(body: Record<string, unknown>): { quantity: number; accessRequestToken: string | null } | Response {
  if (!hasOnlyKeys(body, ["quantity", "access_request_token"])) return fieldError("body", "unknown_field", "A quote accepts quantity and an optional approval token.");
  if (!Number.isSafeInteger(body.quantity) || Number(body.quantity) < 1 || Number(body.quantity) > MAX_PUBLIC_QUANTITY) {
    return fieldError("quantity", "out_of_range", "Public checkout supports an integer quantity from 1 through 8.");
  }
  const token = parseApprovalToken(body.access_request_token);
  if (token instanceof Response) return token;
  return { quantity: Number(body.quantity), accessRequestToken: token };
}

function parseBuyer(value: unknown): { name: string; email: string; normalizedEmail: string } | Response {
  if (!object(value) || !hasOnlyKeys(value, ["name", "email"])) return fieldError("buyer", "invalid_object", "Provide buyer.name and buyer.email.");
  if (typeof value.name !== "string" || value.name.trim().length < 1 || value.name.trim().length > 200) {
    return fieldError("buyer.name", "invalid_name", "Provide the Buyer's real name using 1 to 200 characters.");
  }
  if (typeof value.email !== "string" || value.email.trim().length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email.trim())) {
    return fieldError("buyer.email", "invalid_email", "Provide a valid email address using at most 254 characters.");
  }
  const email = value.email.trim();
  return { name: value.name.trim(), email, normalizedEmail: email.toLowerCase() };
}

function parseOrderRequest(body: Record<string, unknown>): { quoteId: string; buyer: { name: string; email: string; normalizedEmail: string }; accessRequestToken: string | null } | Response {
  if (!hasOnlyKeys(body, ["quote_id", "buyer", "access_request_token"])) return fieldError("body", "unknown_field", "An Order accepts quote_id, buyer, and an optional approval token.");
  if (typeof body.quote_id !== "string" || !UUID_PATTERN.test(body.quote_id)) return fieldError("quote_id", "invalid_uuid", "Provide the quote_id returned by the quote operation.");
  const buyer = parseBuyer(body.buyer);
  if (buyer instanceof Response) return buyer;
  const token = parseApprovalToken(body.access_request_token);
  if (token instanceof Response) return token;
  return { quoteId: body.quote_id, buyer, accessRequestToken: token };
}

async function createOrder(
  client: PoolClient,
  site: AuthenticatedSite,
  quoteId: string,
  buyer: { name: string; email: string; normalizedEmail: string },
  accessRequestToken: string | null,
): Promise<IdempotentResult> {
  const quoteEvent = await client.query<{ event_id: string }>(
    `select event_id from hpos.public_quotes where id = $1 and site_id = $2`,
    [quoteId, site.siteId],
  );
  const eventId = quoteEvent.rows[0]?.event_id;
  if (!eventId) operationError(404, "not_found", "The quote is not available to this Site.");
  const row = await lockedPricing(client, site.siteId, eventId);
  const selectedQuote = await client.query<QuoteRow & { used_at: boolean }>(
    `select quote.*,
            exists (select 1 from hpos.orders order_row where order_row.quote_id = quote.id) as used_at
     from hpos.public_quotes quote
     where quote.id = $1 and quote.site_id = $2
     for update`,
    [quoteId, site.siteId],
  );
  const quote = selectedQuote.rows[0];
  if (!quote) operationError(404, "not_found", "The quote is not available to this Site.");
  if (quote.access_request_id && !accessRequestToken) {
    operationError(404, "not_found", "The approval token is required for private checkout.");
  }
  const privateAccess = quote.access_request_id
    ? await lockedApprovedAccess(client, site.siteId, quote.event_id, accessRequestToken as string)
    : null;
  if (!quote.access_request_id && accessRequestToken) {
    operationError(409, "access_not_required", "This public quote does not accept an approval token.");
  }
  if (quote.used_at) operationError(409, "quote_already_used", "This quote has already created an Order. Request a new quote for another checkout.");
  if (quote.expires_at.getTime() <= Date.now()) operationError(409, "quote_expired", "This quote expired. Request a new quote and show its total before checkout.");

  if (quote.access_request_id) {
    if (!privateAccess || privateAccess.id !== quote.access_request_id
      || privateAccess.token_id !== quote.approval_token_id) {
      operationError(404, "not_found", "The approval token is not valid for this quote.");
    }
    assertPrivateSalesOpen(row);
    const active = await client.query<{ id: string }>(
      `select order_row.id
       from hpos.orders order_row
       left join hpos.reservations reservation
         on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
       where order_row.site_id = $1 and order_row.access_request_id = $2
         and (
           order_row.checkout_status in ('active', 'awaiting_payment_result')
           or order_row.payment_status in ('processing', 'unknown', 'conflicted')
           or reservation.awaiting_provider_verification = true
         )
       order by order_row.created_at desc, order_row.id desc
       limit 1
       for update of order_row`,
      [site.siteId, quote.access_request_id],
    );
    if (active.rows[0]) operationError(409, "access_checkout_in_progress", "This approval already has an active or unresolved checkout.");
  } else {
    assertPublicSalesOpen(row);
  }

  const selectedConnection = await client.query<PaymentConnectionRow>(
    `select connection.id, connection.provider, connection.environment,
            connection.account_reference, connection.location_reference,
            connection.account_eligibility_status, connection.platform_fee_eligibility_status,
            case when mapping.connection_id is null then null else jsonb_build_object(
              'connection_id', mapping.connection_id,
              'resource_type', mapping.resource_type,
              'resource_reference', mapping.resource_reference,
              'verified_at', mapping.verified_at
            ) end as provider_mapping
     from hpos.site_payment_connection_assignments assignment
     join hpos.payment_connections connection
       on connection.id = assignment.connection_id
      and connection.organization_id = assignment.organization_id
     left join hpos.ticket_offering_provider_mappings mapping
       on mapping.site_id = assignment.site_id
      and mapping.offering_id = $2
      and mapping.event_id = $3
      and mapping.connection_id = connection.id
     where assignment.site_id = $1 and assignment.unassigned_at is null
     for update of assignment, connection`,
    [site.siteId, quote.offering_id, quote.event_id],
  );
  const connection = selectedConnection.rows[0];
  if (!connection
    || connection.account_eligibility_status !== "eligible"
    || (connection.platform_fee_eligibility_status !== "eligible"
      && !(connection.provider === "square" && connection.environment === "test"
        && connection.platform_fee_eligibility_status === "ineligible"))
    || (connection.provider === "square" && !connection.location_reference)) {
    operationError(503, "payment_configuration_unavailable", "The Site does not have a verified, eligible payment connection for new Orders.");
  }

  const available = Number(row.capacity) - Number(row.reserved_quantity);
  if (available < quote.quantity) insufficientCapacity(available);
  const pricing = validatedPricing(row, quote.quantity);
  if (pricing.currency !== quote.currency || pricing.price !== Number(quote.unit_price)
    || pricing.subtotal !== Number(quote.subtotal) || pricing.tax !== Number(quote.tax_total)
    || pricing.total !== Number(quote.total) || pricing.platformFee !== Number(quote.platform_fee_amount)
    || pricing.feeRate !== Number(quote.platform_fee_basis_points)
    || JSON.stringify(pricing.buyerFees) !== JSON.stringify(quote.buyer_fees)) {
    operationError(409, "quote_changed", "The checkout total or fee breakdown changed. Request a new quote and obtain the Buyer's confirmation.");
  }

  const buyerRow = await client.query<{ id: string }>(
    `insert into hpos.buyers (site_id, normalized_email, name)
     values ($1, $2, $3)
     on conflict (site_id, normalized_email)
     do update set name = excluded.name, updated_at = clock_timestamp()
     returning id`,
    [site.siteId, buyer.normalizedEmail, buyer.name],
  );
  const orderId = randomUUID();
  const reservationId = randomUUID();
  const orderReference = `HPO-${randomBytes(5).toString("hex").toUpperCase()}`;
  const orderToken = randomBytes(32).toString("base64url");
  const orderTokenHash = createHash("sha256").update(orderToken, "utf8").digest("hex");
  const insertedOrder = await client.query<{ created_at: Date; checkout_expires_at: Date }>(
    `insert into hpos.orders (
       id, site_id, event_id, offering_id, buyer_id, quote_id, order_reference,
       buyer_name, delivery_email, checkout_identity, accepted_quote,
       checkout_expires_at, order_token_hash, payment_connection_id, provider_mapping, order_token,
       access_request_id, approved_attendee_name, approved_attendee_email
     )
     select
       $1, $2, $3, $4, $5, quote_row.id, $7, $8, $9, $10::jsonb, $11::jsonb,
       clock_timestamp() + interval '15 minutes', $12, $13, $14::jsonb, $15, $16, $17, $18
     from hpos.public_quotes quote_row
     where quote_row.id = $6 and quote_row.site_id = $2
       and quote_row.expires_at > clock_timestamp()
     returning created_at, checkout_expires_at`,
    [orderId, site.siteId, quote.event_id, row.ticket_offering_id, buyerRow.rows[0].id,
      quote.id, orderReference, buyer.name, buyer.email,
      JSON.stringify({ name: buyer.name, email: buyer.email }),
      JSON.stringify({
        quote_id: quote.id,
        quantity: quote.quantity,
        unit_price: money(quote.unit_price, quote.currency),
        subtotal: money(quote.subtotal, quote.currency),
        buyer_fees: quote.buyer_fees,
        tax_total: money(quote.tax_total, quote.currency),
        total: money(quote.total, quote.currency),
        platform_fee: money(quote.platform_fee_amount, quote.currency),
        platform_fee_basis_points: quote.platform_fee_basis_points,
      }),
      orderTokenHash, connection.id,
      connection.provider_mapping ? JSON.stringify(connection.provider_mapping) : null,
      orderToken, quote.access_request_id, privateAccess?.name ?? null, privateAccess?.email ?? null],
  );
  if (insertedOrder.rowCount !== 1) {
    operationError(409, "quote_expired", "This quote expired. Request a new quote and show its total before checkout.");
  }
  const reservationExpiry = insertedOrder.rows[0].checkout_expires_at;
  const reserved = await client.query(
    `update hpos.ticket_offerings
     set reserved_quantity = reserved_quantity + $3
     where id = $1 and site_id = $2 and capacity - reserved_quantity >= $3
     returning id`,
    [row.ticket_offering_id, site.siteId, quote.quantity],
  );
  if (reserved.rowCount !== 1) insufficientCapacity(available);
  await client.query(
    `insert into hpos.reservations (id, site_id, event_id, offering_id, order_id, quantity, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [reservationId, site.siteId, quote.event_id, row.ticket_offering_id, orderId, quote.quantity, reservationExpiry],
  );

  return {
    status: 201,
    data: {
      order_id: orderId,
      order_reference: orderReference,
      quantity: quote.quantity,
      created_at: insertedOrder.rows[0].created_at.toISOString(),
      buyer_name: buyer.name,
      delivery_email: buyer.email,
      pricing: {
        unit_price: money(quote.unit_price, quote.currency),
        subtotal: money(quote.subtotal, quote.currency),
        buyer_fees: quote.buyer_fees,
        tax_total: money(quote.tax_total, quote.currency),
        total: money(quote.total, quote.currency),
        platform_fee: money(quote.platform_fee_amount, quote.currency),
        platform_fee_basis_points: quote.platform_fee_basis_points,
      },
      checkout_expires_at: reservationExpiry.toISOString(),
      checkout_status: "active",
      payment_status: "unpaid",
      issuance_status: "not_started",
      tickets: [],
      order_token: orderToken,
      reservation: {
        reservation_id: reservationId,
        quantity: quote.quantity,
        status: "held",
        expires_at: reservationExpiry.toISOString(),
        awaiting_provider_verification: false,
      },
    },
  };
}

export async function handleCheckoutPost(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length === 4 && path[0] === "public" && path[1] === "events" && path[3] === "quotes") {
    const eventId = path[2];
    if (!UUID_PATTERN.test(eventId)) return apiFailure(404, "not_found", "The Event is not available for public checkout.");
    const body = await readJsonBody(request);
    if (body instanceof Response) return body;
    const input = parseQuoteRequest(body);
    if (input instanceof Response) return input;
    return withApiIdempotency(request, site, body,
      (client) => createQuote(client, site, eventId, input.quantity, input.accessRequestToken), mapCheckoutDatabaseError);
  }
  if (path.length === 2 && path[0] === "public" && path[1] === "orders") {
    const body = await readJsonBody(request);
    if (body instanceof Response) return body;
    const input = parseOrderRequest(body);
    if (input instanceof Response) return input;
    return withApiIdempotency(request, site, body,
      (client) => createOrder(client, site, input.quoteId, input.buyer, input.accessRequestToken), mapCheckoutDatabaseError);
  }
  return null;
}
