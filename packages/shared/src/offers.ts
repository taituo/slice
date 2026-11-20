import type { Theme } from './a2ui';

/**
 * Competing offers. A customer asks for something at a location (a pizza, a spin class, sneakers in
 * the mall they are standing in); every provider in range answers with an offer; providers whose
 * policy allows it can counter in a second round. Pure functions here — the auction itself is a
 * Temporal workflow, so rounds, deadlines and late answers are durable and deterministic.
 */

export type Vertical = 'food' | 'fitness' | 'retail';
export type OfferPreference = 'best_value' | 'cheapest' | 'fastest' | 'closest';
export type CompetePolicy = 'hold' | 'match' | 'beat';

export interface OfferDraft {
  vertical: Vertical;
  providerId: string;
  providerName: string;
  listPriceCents: number;
  priceCents: number;
  etaMinutes: number | null;
  distanceM: number;
  headline: string;
  specialTitle: string | null;
  theme: Theme;
  details: Record<string, unknown>;
  floorPriceCents: number;
  competePolicy: CompetePolicy;
  round: number;
}

export interface RankedOffer extends OfferDraft {
  score: number;
}

const WEIGHTS: Record<OfferPreference, { price: number; eta: number; distance: number }> = {
  best_value: { price: 0.6, eta: 0.25, distance: 0.15 },
  cheapest: { price: 0.9, eta: 0.05, distance: 0.05 },
  fastest: { price: 0.2, eta: 0.7, distance: 0.1 },
  closest: { price: 0.2, eta: 0.1, distance: 0.7 },
};

/** Scores in [0,1]: each dimension is best-in-set / this-offer. Ties broken by provider id for stability. */
export function rankOffers(offers: OfferDraft[], pref: OfferPreference = 'best_value'): RankedOffer[] {
  if (!offers.length) return [];
  const w = WEIGHTS[pref];
  const minPrice = Math.min(...offers.map((o) => Math.max(1, o.priceCents)));
  const etas = offers.map((o) => o.etaMinutes).filter((e): e is number => e != null);
  const minEta = etas.length ? Math.min(...etas.map((e) => Math.max(1, e))) : 1;
  const minDist = Math.min(...offers.map((o) => Math.max(1, o.distanceM)));
  return offers
    .map((o) => {
      const price = minPrice / Math.max(1, o.priceCents);
      const eta = o.etaMinutes == null ? 1 : minEta / Math.max(1, o.etaMinutes);
      const dist = minDist / Math.max(1, o.distanceM);
      const score = Math.round((w.price * price + w.eta * eta + w.distance * dist) * 1000) / 1000;
      return { ...o, score };
    })
    .sort((a, b) => b.score - a.score || a.providerId.localeCompare(b.providerId));
}

/**
 * Second bidding round. A provider with policy `match` drops to the best competing price; `beat`
 * undercuts it by 2% (at least 50 cents). Nobody goes below their own floor, and nobody raises.
 */
export function counterRound(offers: OfferDraft[]): OfferDraft[] {
  return offers.map((o) => {
    if (o.competePolicy === 'hold') return o;
    const rivals = offers.filter((x) => x.providerId !== o.providerId);
    if (!rivals.length) return o;
    const best = Math.min(...rivals.map((x) => x.priceCents));
    if (best >= o.priceCents) return o;
    const target = o.competePolicy === 'match' ? best : best - Math.max(50, Math.round(best * 0.02));
    const price = Math.max(o.floorPriceCents, target);
    if (price >= o.priceCents) return o;
    const label = price < best ? 'Beats the nearby price' : price === best ? 'Price matched' : 'Price lowered to compete';
    return { ...o, priceCents: price, round: o.round + 1, specialTitle: label };
  });
}

/** Food: idle ovens discount themselves to attract orders. */
export function idleDiscountPct(activeOrders: number, capacity: number): number {
  const load = activeOrders / Math.max(1, capacity);
  if (load < 0.25) return 10;
  if (load < 0.5) return 5;
  return 0;
}

export interface SpecialRule {
  id: string;
  title: string;
  kind: 'percent_off' | 'fixed_off' | 'free_item';
  value: number;
  sku: string | null;
  minSubtotalCents: number;
  startsAt: string;
  endsAt: string;
}

/** Best single special for a subtotal at a time; free items are valued at `freeItemValueCents`. */
export function bestSpecial(
  subtotalCents: number,
  specials: SpecialRule[],
  now: Date,
  freeItemValueCents = 0,
): { special: SpecialRule; discountCents: number } | null {
  let best: { special: SpecialRule; discountCents: number } | null = null;
  const t = now.getTime();
  for (const s of specials) {
    if (t < Date.parse(s.startsAt) || t >= Date.parse(s.endsAt) || subtotalCents < s.minSubtotalCents) continue;
    const discount =
      s.kind === 'percent_off'
        ? Math.round((subtotalCents * s.value) / 100)
        : s.kind === 'fixed_off'
          ? Math.min(subtotalCents, Math.round(s.value))
          : freeItemValueCents;
    if (!best || discount > best.discountCents) best = { special: s, discountCents: discount };
  }
  return best;
}

export function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(toRad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return Math.round(2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h))));
}
