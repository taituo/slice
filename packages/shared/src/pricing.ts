import type { Campaign, CartLine, MenuItem, PricedLine, Quote } from './types';

export interface PricingContext {
  now: Date;
  region: string;
  distanceKm: number;
  campaigns: Campaign[];
  /** Variant of the "fast-delivery-pricing" experiment for this customer. */
  experimentVariant: 'control' | 'treatment';
  /** Optional per-pizzeria price overrides (sku → cents). */
  overrides?: Record<string, number>;
}

export const BASE_DELIVERY_FEE_CENTS = 290;
export const FEE_PER_KM_CENTS = 40;
export const FREE_DELIVERY_THRESHOLD_CENTS = 3500;

export class PricingError extends Error {}

function campaignApplies(c: Campaign, ctx: PricingContext): boolean {
  const t = ctx.now.getTime();
  if (t < Date.parse(c.startsAt) || t >= Date.parse(c.endsAt)) return false;
  if (c.regions && !c.regions.includes(ctx.region)) return false;
  return true;
}

/**
 * Pure pricing function — the single source of truth for what a customer pays.
 * Runs inside an activity (so price changes never break workflow determinism) and in clients for
 * instant cart previews.
 */
export function priceCart(items: CartLine[], menu: MenuItem[], ctx: PricingContext): Quote {
  const bySku = new Map(menu.map((m) => [m.sku, m]));
  const lines: PricedLine[] = items.map((line) => {
    const item = bySku.get(line.sku);
    if (!item) throw new PricingError(`Unknown item: ${line.sku}`);
    const unit = ctx.overrides?.[line.sku] ?? item.basePriceCents;
    return { ...line, name: item.name, unitPriceCents: unit, lineTotalCents: unit * line.qty };
  });
  const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);

  // Best single campaign wins (no stacking) — easy to explain to customers and franchisees.
  let best: { campaign: Campaign; discount: number } | null = null;
  for (const c of ctx.campaigns) {
    if (!campaignApplies(c, ctx)) continue;
    const eligible = lines
      .filter((l) => !c.skus || c.skus.includes(l.sku))
      .reduce((s, l) => s + l.lineTotalCents, 0);
    const discount = Math.round((eligible * c.percentOff) / 100);
    if (!best || discount > best.discount) best = { campaign: c, discount };
  }
  const discount = best?.discount ?? 0;

  let deliveryFee = BASE_DELIVERY_FEE_CENTS + Math.round(Math.max(0, ctx.distanceKm - 2) * FEE_PER_KM_CENTS);
  if (subtotal - discount >= FREE_DELIVERY_THRESHOLD_CENTS) deliveryFee = 0;
  // Experiment: "fast-delivery-pricing" treatment halves the delivery fee for short trips.
  if (ctx.experimentVariant === 'treatment' && ctx.distanceKm <= 3) deliveryFee = Math.round(deliveryFee / 2);

  return {
    lines,
    subtotalCents: subtotal,
    discountCents: discount,
    deliveryFeeCents: deliveryFee,
    totalCents: subtotal - discount + deliveryFee,
    currency: 'EUR',
    campaignCode: best?.campaign.code ?? null,
    experimentVariant: ctx.experimentVariant,
  };
}

export function formatEur(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`;
}
