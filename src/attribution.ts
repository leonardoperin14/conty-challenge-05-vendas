export type SignalMappings = ReadonlyMap<string, string>;

export interface AttributionMappings {
  coupons: SignalMappings;
  utms: SignalMappings;
}

export interface AttributionResult {
  creatorId: string | null;
  source: "coupon" | "utm" | "none";
}

export function normalizeCoupon(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized ? normalized : null;
}

export function normalizeUtmContent(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function resolveAttribution(
  coupon: string | null | undefined,
  utmContent: string | null | undefined,
  mappings: AttributionMappings,
): AttributionResult {
  const couponKey = normalizeCoupon(coupon);
  const couponCreator = couponKey ? mappings.coupons.get(couponKey) : undefined;
  if (couponCreator) return { creatorId: couponCreator, source: "coupon" };

  const utmKey = normalizeUtmContent(utmContent);
  const utmCreator = utmKey ? mappings.utms.get(utmKey) : undefined;
  if (utmCreator) return { creatorId: utmCreator, source: "utm" };

  return { creatorId: null, source: "none" };
}
