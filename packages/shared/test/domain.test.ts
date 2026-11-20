import { describe, expect, it } from 'vitest';
import { assignVariant, bucketOf, haversineKm, priceCart, type Campaign, type MenuItem } from '../src';

const menu: MenuItem[] = [
  { sku: 'margherita', name: 'Margherita', description: '', category: 'pizza', basePriceCents: 950, tags: [] },
  { sku: 'lemonade', name: 'Lemonade', description: '', category: 'drink', basePriceCents: 390, tags: [] },
];
const winter: Campaign = { code: 'WINTER10', name: 'Winter', percentOff: 10, startsAt: '2026-11-15T00:00:00Z', endsAt: '2026-12-01T00:00:00Z', regions: null, skus: ['margherita'] };
const xmas: Campaign = { code: 'XMAS', name: 'Xmas', percentOff: 15, startsAt: '2026-12-01T00:00:00Z', endsAt: '2026-12-27T00:00:00Z', regions: ['de-berlin-mitte'], skus: null };
const ctx = (over: Partial<Parameters<typeof priceCart>[2]> = {}) => ({
  now: new Date('2026-11-20T12:00:00Z'),
  region: 'de-berlin-mitte',
  distanceKm: 1.5,
  campaigns: [winter, xmas],
  experimentVariant: 'control' as const,
  ...over,
});

describe('priceCart', () => {
  it('applies only campaigns active now, only to eligible SKUs', () => {
    const q = priceCart([{ sku: 'margherita', qty: 2 }, { sku: 'lemonade', qty: 1 }], menu, ctx());
    expect(q.subtotalCents).toBe(2290);
    expect(q.discountCents).toBe(190);
    expect(q.campaignCode).toBe('WINTER10');
    expect(q.deliveryFeeCents).toBe(290);
    expect(q.totalCents).toBe(2290 - 190 + 290);
  });

  it('picks the best single campaign and respects regions', () => {
    const dec = new Date('2026-12-10T12:00:00Z');
    expect(priceCart([{ sku: 'margherita', qty: 1 }], menu, ctx({ now: dec })).campaignCode).toBe('XMAS');
    expect(priceCart([{ sku: 'margherita', qty: 1 }], menu, ctx({ now: dec, region: 'de-berlin-wedding' })).campaignCode).toBeNull();
  });

  it('charges distance, waives fee over the threshold, halves it for the treatment group', () => {
    expect(priceCart([{ sku: 'lemonade', qty: 1 }], menu, ctx({ distanceKm: 5 })).deliveryFeeCents).toBe(290 + 120);
    expect(priceCart([{ sku: 'margherita', qty: 5 }], menu, ctx()).deliveryFeeCents).toBe(0);
    expect(priceCart([{ sku: 'lemonade', qty: 1 }], menu, ctx({ experimentVariant: 'treatment' })).deliveryFeeCents).toBe(145);
  });

  it('uses per-pizzeria overrides and rejects unknown SKUs', () => {
    expect(priceCart([{ sku: 'margherita', qty: 1 }], menu, ctx({ campaigns: [], overrides: { margherita: 1000 } })).subtotalCents).toBe(1000);
    expect(() => priceCart([{ sku: 'calzone', qty: 1 }], menu, ctx())).toThrow(/Unknown item/);
  });
});

describe('canary assignment', () => {
  it('is deterministic and roughly matches the percentage', () => {
    expect(bucketOf('cust-1', 'exp')).toBe(bucketOf('cust-1', 'exp'));
    const rollout = { key: 'fast-delivery-pricing', percent: 20 };
    const treated = Array.from({ length: 5000 }, (_, i) => assignVariant(rollout, `c${i}`, 'x')).filter((v) => v === 'treatment').length;
    expect(treated / 5000).toBeGreaterThan(0.17);
    expect(treated / 5000).toBeLessThan(0.23);
  });
  it('gives canary regions the treatment for everyone', () => {
    expect(assignVariant({ key: 'k', regions: ['de-berlin-kreuzberg'], percent: 0 }, 'anyone', 'de-berlin-kreuzberg')).toBe('treatment');
    expect(assignVariant(undefined, 'anyone', 'de-berlin-kreuzberg')).toBe('control');
  });
});

describe('geo', () => {
  it('computes great-circle distance', () => {
    // Berlin Alexanderplatz → Brandenburger Tor ≈ 2.5 km
    expect(haversineKm({ lat: 52.5219, lng: 13.4132 }, { lat: 52.5163, lng: 13.3777 })).toBeCloseTo(2.49, 1);
  });
});
