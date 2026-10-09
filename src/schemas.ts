import { z } from "zod";

const id = z.string().trim().min(1).max(200);
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const optionalSignal = z.union([z.string().max(500), z.null()]).optional();

export const orderWebhookSchema = z.object({
  id,
  total_cents: cents,
  currency: z.literal("BRL"),
  status: z.literal("paid"),
  coupon: optionalSignal,
  utm: z.union([
    z.object({
      source: optionalSignal,
      medium: optionalSignal,
      campaign: optionalSignal,
      content: optionalSignal,
      term: optionalSignal,
    }).strict(),
    z.null(),
  ]).optional(),
}).strict();

export const refundWebhookSchema = z.object({
  id,
  order_id: id,
  amount_cents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

export type ParsedOrderWebhook = z.infer<typeof orderWebhookSchema>;
export type ParsedRefundWebhook = z.infer<typeof refundWebhookSchema>;
