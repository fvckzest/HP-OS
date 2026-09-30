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

function feeAmount(subtotal: number, basisPoints: number): number {
  const rounded = (BigInt(subtotal) * BigInt(basisPoints) + 5000n) / 10000n;
  if (rounded > MAX_AMOUNT) operationError(503, "payment_configuration_unavailable", "The configured platform fee is outside the supported amount range.");
  return Number(rounded);
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

function validatedPricing(row: PricingRow) {
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
  let feesTotal = 0;
  for (const fee of row.buyer_fees) {
    if (!fee || typeof fee.code !== "string" || typeof fee.label !== "string"
      || !Number.isSafeInteger(fee.amount) || fee.amount < 0 || fee.currency !== row.currency) {
      operationError(503, "payment_configuration_unavailable", "Buyer-fee configuration is invalid or uses a different currency from the Ticket.");
    }
    feesTotal = addSafeAmounts(feesTotal, fee.amount);
  }
  const subtotal = price;
  const total = addSafeAmounts(subtotal, feesTotal, tax);
  const platformFee = feeAmount(subtotal, Number(row.platform_fee_basis_points));
  return { currency: row.currency, price, subtotal, buyerFees: row.buyer_fees, tax, total, platformFee, feeRate: Number(row.platform_fee_basis_points) };
}

async function createQuote(client: PoolClient, site: AuthenticatedSite, eventId: string): Promise<IdempotentResult> {
  const row = await lockedPricing(client, site.siteId, eventId);
  assertPublicSalesOpen(row);
  const pricing = validatedPricing(row);
  const quoteId = randomUUID();
  const inserted = await client.query<QuoteRow>(
    `insert into hpos.public_quotes (
       id, site_id, event_id, offering_id, quantity, currency, unit_price, subtotal,
       buyer_fees, tax_total, total, platform_fee_basis_points, platform_fee_amount,
       expires_at
     ) values (
       $1, $2, $3, $4, 1, $5, $6, $7, $8::jsonb, $9, $10, $11, $12,
       clock_timestamp() + interval '10 minutes'
     )
     returning id, site_id, event_id, offering_id, quantity, currency, unit_price,
       subtotal, buyer_fees, tax_total, total, platform_fee_basis_points,
       platform_fee_amount, expires_at`,
    [quoteId, site.siteId, eventId, row.ticket_offering_id, pricing.currency, pricing.price,
      pricing.subtotal, JSON.stringify(pricing.buyerFees), pricing.tax, pricing.total,
      pricing.feeRate, pricing.platformFee],
  );
  return { status: 201, data: quoteData(inserted.rows[0]) };
}

function parseQuoteRequest(body: Record<string, unknown>): Response | null {
  if (!hasOnlyKeys(body, ["quantity"])) return fieldError("body", "unknown_field", "A quote accepts only quantity.");
  if (body.quantity !== 1) return fieldError("quantity", "unsupported_quantity", "This checkout currently quotes one Ticket at a time.");
  return null;
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

function parseOrderRequest(body: Record<string, unknown>): { quoteId: string; buyer: { name: string; email: string; normalizedEmail: string } } | Response {
  if (!hasOnlyKeys(body, ["quote_id", "buyer"])) return fieldError("body", "unknown_field", "An Order accepts only quote_id and buyer.");
  if (typeof body.quote_id !== "string" || !UUID_PATTERN.test(body.quote_id)) return fieldError("quote_id", "invalid_uuid", "Provide the quote_id returned by the quote operation.");
  const buyer = parseBuyer(body.buyer);
  if (buyer instanceof Response) return buyer;
  return { quoteId: body.quote_id, buyer };
}

async function createOrder(
  client: PoolClient,
  site: AuthenticatedSite,
  quoteId: string,
  buyer: { name: string; email: string; normalizedEmail: string },
): Promise<IdempotentResult> {
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
  if (quote.used_at) operationError(409, "quote_already_used", "This quote has already created an Order. Request a new quote for another checkout.");
  if (quote.expires_at.getTime() <= Date.now()) operationError(409, "quote_expired", "This quote expired. Request a new quote and show its total before checkout.");

  const row = await lockedPricing(client, site.siteId, quote.event_id);
  assertPublicSalesOpen(row);
  if (Number(row.reserved_quantity) >= Number(row.capacity)) operationError(409, "sold_out", "No Tickets remain available for this Event.");
  const pricing = validatedPricing(row);
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
       checkout_expires_at, order_token_hash
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
       clock_timestamp() + interval '15 minutes', $12
     ) returning created_at, checkout_expires_at`,
    [orderId, site.siteId, quote.event_id, row.ticket_offering_id, buyerRow.rows[0].id,
      quote.id, orderReference, buyer.name, buyer.email,
      JSON.stringify({ name: buyer.name, email: buyer.email }),
      JSON.stringify({
        quote_id: quote.id,
        quantity: 1,
        unit_price: money(quote.unit_price, quote.currency),
        subtotal: money(quote.subtotal, quote.currency),
        buyer_fees: quote.buyer_fees,
        tax_total: money(quote.tax_total, quote.currency),
        total: money(quote.total, quote.currency),
        platform_fee: money(quote.platform_fee_amount, quote.currency),
        platform_fee_basis_points: quote.platform_fee_basis_points,
      }),
      orderTokenHash],
  );
  const reservationExpiry = insertedOrder.rows[0].checkout_expires_at;
  const reserved = await client.query(
    `update hpos.ticket_offerings
     set reserved_quantity = reserved_quantity + 1
     where id = $1 and site_id = $2 and capacity > reserved_quantity
     returning id`,
    [row.ticket_offering_id, site.siteId],
  );
  if (reserved.rowCount !== 1) operationError(409, "sold_out", "No Tickets remain available for this Event.");
  await client.query(
    `insert into hpos.reservations (id, site_id, event_id, offering_id, order_id, expires_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [reservationId, site.siteId, quote.event_id, row.ticket_offering_id, orderId, reservationExpiry],
  );

  return {
    status: 201,
    data: {
      order_id: orderId,
      order_reference: orderReference,
      quantity: 1,
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
        quantity: 1,
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
    const error = parseQuoteRequest(body);
    if (error) return error;
    return withApiIdempotency(request, site, body, (client) => createQuote(client, site, eventId), mapCheckoutDatabaseError);
  }
  if (path.length === 2 && path[0] === "public" && path[1] === "orders") {
    const body = await readJsonBody(request);
    if (body instanceof Response) return body;
    const input = parseOrderRequest(body);
    if (input instanceof Response) return input;
    return withApiIdempotency(request, site, body, (client) => createOrder(client, site, input.quoteId, input.buyer), mapCheckoutDatabaseError);
  }
  return null;
}
