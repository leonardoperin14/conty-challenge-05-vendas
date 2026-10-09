export type AttributionSource = "coupon" | "utm" | "none";
export type RefundStatus = "PENDING_ORDER" | "APPLIED" | "CLAMPED";

export interface UtmParameters {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  content?: string | null;
  term?: string | null;
}

export interface OrderWebhook {
  id: string;
  total_cents: number;
  currency: "BRL";
  status: "paid";
  coupon?: string | null;
  utm?: UtmParameters | null;
}

export interface RefundWebhook {
  id: string;
  order_id: string;
  amount_cents: number;
}

export interface OrderRecord {
  order_id: string;
  total_cents: number;
  refunded_total_cents: number;
  currency: "BRL";
  status: "paid";
  coupon: string | null;
  utm: UtmParameters | null;
  creator_id: string | null;
  attribution_source: AttributionSource;
  created_at: string;
  refunds: RefundRecord[];
}

export interface RefundRecord {
  id: string;
  order_id: string;
  amount_cents: number;
  applied_cents: number;
  excess_cents: number;
  status: RefundStatus;
  received_at: string;
  applied_at: string | null;
}

export interface OrderResponse {
  duplicate: boolean;
  order: OrderRecord;
  net_attributed_cents: number;
}

export interface RefundResponse {
  duplicate: boolean;
  refund: RefundRecord;
}

export interface PendingRefundsResponse {
  order_received: false;
  order_id: string;
  creator_id: null;
  attribution_source: "none";
  original_total_cents: null;
  refunded_total_cents: null;
  net_attributed_cents: null;
  refunds: RefundRecord[];
}

export type AttributionResponse = OrderResponse | PendingRefundsResponse;
