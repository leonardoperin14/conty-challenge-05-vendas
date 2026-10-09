import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { normalizeCoupon, normalizeUtmContent, resolveAttribution } from "./attribution.js";
import { inTransaction } from "./database.js";
import type {
  AttributionResponse,
  OrderRecord,
  OrderResponse,
  OrderWebhook,
  PendingRefundsResponse,
  RefundRecord,
  RefundResponse,
  RefundWebhook,
  UtmParameters,
} from "./domain.js";

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cleanOptional(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function canonicalUtm(utm: UtmParameters | null | undefined): UtmParameters | null {
  if (!utm) return null;
  const normalized: UtmParameters = {};
  for (const key of ["source", "medium", "campaign", "content", "term"] as const) {
    const value = cleanOptional(utm[key]);
    if (value !== null) normalized[key] = value;
  }
  return Object.keys(normalized).length ? normalized : null;
}

function mappings(database: DatabaseSync): { coupons: Map<string, string>; utms: Map<string, string> } {
  const coupons = new Map<string, string>();
  const utms = new Map<string, string>();
  const rows = database.prepare("SELECT signal_type, signal_value, creator_id FROM creator_attribution_rules").all() as Array<{
    signal_type: "coupon" | "utm";
    signal_value: string;
    creator_id: string;
  }>;
  for (const row of rows) (row.signal_type === "coupon" ? coupons : utms).set(row.signal_value, row.creator_id);
  return { coupons, utms };
}

function asNumber(value: SQLOutputValue | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  throw new Error("Unexpected non-numeric SQLite value");
}

function refundRecord(row: Record<string, SQLOutputValue>): RefundRecord {
  return {
    id: String(row.refund_id),
    order_id: String(row.order_id),
    amount_cents: asNumber(row.requested_cents),
    applied_cents: asNumber(row.applied_cents),
    excess_cents: asNumber(row.excess_cents),
    status: row.status as RefundRecord["status"],
    received_at: String(row.received_at),
    applied_at: row.applied_at === null ? null : String(row.applied_at),
  };
}

function refundsForOrder(database: DatabaseSync, orderId: string): RefundRecord[] {
  const rows = database.prepare("SELECT refund_id, order_id, requested_cents, applied_cents, excess_cents, status, received_at, applied_at FROM refunds WHERE order_id = ? ORDER BY sequence").all(orderId) as Array<Record<string, SQLOutputValue>>;
  return rows.map(refundRecord);
}

function getOrderRecord(database: DatabaseSync, orderId: string): OrderRecord | null {
  const row = database.prepare("SELECT order_id, total_cents, refunded_total_cents, currency, status, coupon, utm_json, creator_id, attribution_source, created_at FROM orders WHERE order_id = ?").get(orderId) as Record<string, SQLOutputValue> | undefined;
  if (!row) return null;
  return {
    order_id: String(row.order_id),
    total_cents: asNumber(row.total_cents),
    refunded_total_cents: asNumber(row.refunded_total_cents),
    currency: "BRL",
    status: "paid",
    coupon: row.coupon === null ? null : String(row.coupon),
    utm: row.utm_json === null ? null : JSON.parse(String(row.utm_json)) as UtmParameters,
    creator_id: row.creator_id === null ? null : String(row.creator_id),
    attribution_source: row.attribution_source as OrderRecord["attribution_source"],
    created_at: String(row.created_at),
    refunds: refundsForOrder(database, orderId),
  };
}

function orderResponse(database: DatabaseSync, orderId: string, duplicate: boolean): OrderResponse {
  const order = getOrderRecord(database, orderId);
  if (!order) throw new Error(`Order ${orderId} was not found after processing`);
  return {
    duplicate,
    order,
    net_attributed_cents: order.creator_id ? order.total_cents - order.refunded_total_cents : 0,
  };
}

function applyPendingRefunds(database: DatabaseSync, orderId: string): void {
  const pending = database.prepare("SELECT sequence, requested_cents FROM refunds WHERE order_id = ? AND status = 'PENDING_ORDER' ORDER BY sequence").all(orderId) as Array<{
    sequence: number;
    requested_cents: number;
  }>;
  const order = database.prepare("SELECT total_cents, refunded_total_cents FROM orders WHERE order_id = ?").get(orderId) as {
    total_cents: number;
    refunded_total_cents: number;
  };
  let refunded = order.refunded_total_cents;
  for (const refund of pending) {
    const applied = Math.min(refund.requested_cents, order.total_cents - refunded);
    const excess = refund.requested_cents - applied;
    refunded += applied;
    const now = new Date().toISOString();
    const orderUpdate = database.prepare("UPDATE orders SET refunded_total_cents = ? WHERE order_id = ? AND refunded_total_cents + ? <= total_cents").run(refunded, orderId, applied);
    if (Number(orderUpdate.changes) !== 1) throw new Error("Could not safely update the order refund total");
    const refundUpdate = database.prepare("UPDATE refunds SET applied_cents = ?, excess_cents = ?, status = ?, applied_order_id = ?, applied_at = ? WHERE sequence = ? AND status = 'PENDING_ORDER'").run(
      applied,
      excess,
      excess === 0 ? "APPLIED" : "CLAMPED",
      orderId,
      now,
      refund.sequence,
    );
    if (Number(refundUpdate.changes) !== 1) throw new Error("Could not safely reconcile a pending refund");
  }
}

export function ingestOrder(database: DatabaseSync, input: OrderWebhook): OrderResponse {
  const coupon = cleanOptional(input.coupon);
  const utm = canonicalUtm(input.utm);
  const fingerprintValue = fingerprint({
    id: input.id,
    total_cents: input.total_cents,
    currency: input.currency,
    status: input.status,
    coupon: normalizeCoupon(coupon),
    utm,
  });

  return inTransaction(database, () => {
    const existing = database.prepare("SELECT payload_fingerprint FROM orders WHERE order_id = ?").get(input.id) as { payload_fingerprint: string } | undefined;
    if (existing) {
      if (existing.payload_fingerprint !== fingerprintValue) throw new ConflictError("Order ID already exists with different business data");
      return orderResponse(database, input.id, true);
    }

    const attribution = resolveAttribution(coupon, utm?.content, mappings(database));
    database.prepare(`
      INSERT INTO orders (
        order_id, total_cents, currency, status, coupon, utm_json,
        payload_fingerprint, creator_id, attribution_source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.total_cents,
      input.currency,
      input.status,
      coupon,
      utm === null ? null : JSON.stringify(utm),
      fingerprintValue,
      attribution.creatorId,
      attribution.source,
      new Date().toISOString(),
    );

    applyPendingRefunds(database, input.id);
    return orderResponse(database, input.id, false);
  });
}

function getRefund(database: DatabaseSync, refundId: string): RefundRecord | null {
  const row = database.prepare("SELECT refund_id, order_id, requested_cents, applied_cents, excess_cents, status, received_at, applied_at FROM refunds WHERE refund_id = ?").get(refundId) as Record<string, SQLOutputValue> | undefined;
  return row ? refundRecord(row) : null;
}

export function ingestRefund(database: DatabaseSync, input: RefundWebhook): RefundResponse {
  const fingerprintValue = fingerprint({ id: input.id, order_id: input.order_id, amount_cents: input.amount_cents });
  return inTransaction(database, () => {
    const existing = database.prepare("SELECT payload_fingerprint FROM refunds WHERE refund_id = ?").get(input.id) as { payload_fingerprint: string } | undefined;
    if (existing) {
      if (existing.payload_fingerprint !== fingerprintValue) throw new ConflictError("Refund ID already exists with different business data");
      const refund = getRefund(database, input.id);
      if (!refund) throw new Error(`Refund ${input.id} was not found after processing`);
      return { duplicate: true, refund };
    }

    const order = database.prepare("SELECT total_cents, refunded_total_cents FROM orders WHERE order_id = ?").get(input.order_id) as {
      total_cents: number;
      refunded_total_cents: number;
    } | undefined;
    const receivedAt = new Date().toISOString();
    if (!order) {
      database.prepare(`
        INSERT INTO refunds (refund_id, order_id, requested_cents, status, payload_fingerprint, received_at)
        VALUES (?, ?, ?, 'PENDING_ORDER', ?, ?)
      `).run(input.id, input.order_id, input.amount_cents, fingerprintValue, receivedAt);
    } else {
      const applied = Math.min(input.amount_cents, order.total_cents - order.refunded_total_cents);
      const excess = input.amount_cents - applied;
      const nextTotal = order.refunded_total_cents + applied;
      const orderUpdate = database.prepare("UPDATE orders SET refunded_total_cents = ? WHERE order_id = ? AND refunded_total_cents + ? <= total_cents").run(nextTotal, input.order_id, applied);
      if (Number(orderUpdate.changes) !== 1) throw new Error("Could not safely update the order refund total");
      database.prepare(`
        INSERT INTO refunds (
          refund_id, order_id, requested_cents, applied_cents, excess_cents,
          status, payload_fingerprint, received_at, applied_order_id, applied_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.order_id,
        input.amount_cents,
        applied,
        excess,
        excess === 0 ? "APPLIED" : "CLAMPED",
        fingerprintValue,
        receivedAt,
        input.order_id,
        new Date().toISOString(),
      );
    }
    const refund = getRefund(database, input.id);
    if (!refund) throw new Error(`Refund ${input.id} was not found after processing`);
    return { duplicate: false, refund };
  });
}

export function getAttribution(database: DatabaseSync, orderId: string): AttributionResponse | null {
  const order = getOrderRecord(database, orderId);
  if (order) return orderResponse(database, orderId, false);

  const refunds = refundsForOrder(database, orderId);
  if (!refunds.length) return null;
  const pending: PendingRefundsResponse = {
    order_received: false,
    order_id: orderId,
    creator_id: null,
    attribution_source: "none",
    original_total_cents: null,
    refunded_total_cents: null,
    net_attributed_cents: null,
    refunds,
  };
  return pending;
}
