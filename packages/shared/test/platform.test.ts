import { describe, expect, it } from 'vitest';
import {
  bestSpecial,
  checkAdCopy,
  counterRound,
  rankOffers,
  Surface,
  thompsonPick,
  validateA2ui,
  variantsToPause,
  type OfferDraft,
} from '../src';

const draft = (o: Partial<OfferDraft>): OfferDraft => ({
  vertical: 'retail',
  providerId: 'p',
  providerName: 'P',
  listPriceCents: 10000,
  priceCents: 10000,
  etaMinutes: null,
  distanceM: 100,
  headline: 'Shoes',
  specialTitle: null,
  theme: {},
  details: {},
  floorPriceCents: 10000,
  competePolicy: 'hold',
  round: 1,
  ...o,
});

describe('competing offers', () => {
  it('ranks by preference', () => {
    const cheap = draft({ providerId: 'cheap', priceCents: 8000, distanceM: 500 });
    const near = draft({ providerId: 'near', priceCents: 9000, distanceM: 20 });
    expect(rankOffers([cheap, near], 'cheapest')[0]!.providerId).toBe('cheap');
    expect(rankOffers([cheap, near], 'closest')[0]!.providerId).toBe('near');
  });

  it('counter round: beat undercuts, match equals, nobody goes below their floor', () => {
    const rival = draft({ providerId: 'rival', priceCents: 10000 });
    const beater = draft({ providerId: 'beater', priceCents: 11000, floorPriceCents: 9000, competePolicy: 'beat' });
    const matcher = draft({ providerId: 'matcher', priceCents: 10500, floorPriceCents: 9500, competePolicy: 'match' });
    const stubborn = draft({ providerId: 'stubborn', priceCents: 10800, floorPriceCents: 10700, competePolicy: 'beat' });
    const out = Object.fromEntries(counterRound([rival, beater, matcher, stubborn]).map((o) => [o.providerId, o]));
    expect(out.beater!.priceCents).toBe(9800); // 10000 - 2%
    expect(out.beater!.specialTitle).toBe('Beats the nearby price');
    expect(out.matcher!.priceCents).toBe(10000); // bids are sealed: matches the best round-1 price
    expect(out.stubborn!.priceCents).toBe(10700);
    expect(out.stubborn!.specialTitle).toBe('Price lowered to compete');
    expect(out.rival!.round).toBe(1);
  });

  it('applies the best single special', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    const specials = [
      { id: 'a', title: '10%', kind: 'percent_off' as const, value: 10, sku: null, minSubtotalCents: 0, startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-12-01T00:00:00Z' },
      { id: 'b', title: '€5 off over €40', kind: 'fixed_off' as const, value: 500, sku: null, minSubtotalCents: 4000, startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-12-01T00:00:00Z' },
    ];
    expect(bestSpecial(3000, specials, now)!.special.id).toBe('a');
    expect(bestSpecial(4500, specials, now)!.special.id).toBe('b');
    expect(bestSpecial(4500, specials, new Date('2026-12-02T00:00:00Z'))).toBeNull();
  });
});

describe('A2UI', () => {
  it('builds valid themed surfaces', () => {
    const s = new Surface('offer-1', { primaryColor: '#111', mood: 'bold' });
    const card = s.card('card', s.column('body', [s.text('t', 'Hello', 'h3'), s.button('go', 'Choose', 'choose_offer', { offerId: 'x' })]));
    const msgs = s.build([card]);
    expect(validateA2ui(msgs)).toEqual([]);
    expect((msgs[0] as any).createSurface.metadata['slice.theme'].mood).toBe('bold');
    expect((msgs[0] as any).createSurface.surfaceId).toBe('offer_1');
  });
  it('catches dangling references', () => {
    const msgs = [
      { version: 'v1.0', createSurface: { surfaceId: 's', catalogId: 'x' } },
      { version: 'v1.0', updateComponents: { surfaceId: 's', components: [{ id: 'root', component: 'Column', children: ['missing'] }] } },
    ] as any;
    expect(validateA2ui(msgs)).toContain('root references missing missing');
  });
});

describe('ads', () => {
  it('Thompson sampling favours the clear winner', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const ads = [
      { id: 'good', impressions: 1000, clicks: 120 },
      { id: 'bad', impressions: 1000, clicks: 10 },
    ];
    const wins = Array.from({ length: 200 }, () => thompsonPick(ads, rand)!.id).filter((x) => x === 'good').length;
    expect(wins).toBeGreaterThan(190);
  });
  it('pauses variants under half the best CTR once mature', () => {
    expect(variantsToPause([{ id: 'a', impressions: 300, clicks: 30 }, { id: 'b', impressions: 300, clicks: 5 }])).toEqual(['b']);
    expect(variantsToPause([{ id: 'a', impressions: 50, clicks: 30 }, { id: 'b', impressions: 50, clicks: 0 }])).toEqual([]);
  });
  it('rejects claims the offer does not back', () => {
    expect(checkAdCopy({ headline: '20% off pizza', body: 'Today', cta: 'Order' }, { percentOff: 15 })).toContain('claims 20% without a matching offer');
    expect(checkAdCopy({ headline: 'The best pizza in Berlin', body: 'x', cta: 'Order' }, {})[0]).toMatch(/unverifiable/);
    expect(checkAdCopy({ headline: '15% off this week', body: 'At Slice Alexanderplatz', cta: 'Order now' }, { percentOff: 15 })).toEqual([]);
  });
});
