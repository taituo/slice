import { closePool, getPool } from './pool';
import { migrate } from './migrate';
import { setFlag, upsertCampaign, upsertMenuItem, upsertPizzeria } from './repo';
import type { MenuItem, Pizzeria } from '@slice/shared';
import { seedPlatform, seedTenants } from './seed-platform';

/**
 * The story starts with one pizzeria in Berlin-Mitte that grew into ten kitchens and three brands:
 *  - Slice Network      — the real franchise, storefronts with dine-in
 *  - Night Owl Pizza    — a virtual brand cooked in Slice kitchens, late-night menu
 *  - Basil & Bloom      — a virtual plant-based brand, delivered under its own name
 */
export const brands = [
  { id: 'slice', name: 'Slice Network', kind: 'real', tagline: 'From one oven in Mitte to your door.', accent: '#d9480f' },
  { id: 'nightowl', name: 'Night Owl Pizza', kind: 'virtual', tagline: 'Hot slices after dark.', accent: '#5f3dc4' },
  { id: 'bloom', name: 'Basil & Bloom', kind: 'virtual', tagline: 'Plant-based pies, wood-fired.', accent: '#2b8a3e' },
] as const;

type SeedPizzeria = Omit<Pizzeria, 'brandName'>;

export const pizzerias: SeedPizzeria[] = [
  { id: 'ber-mitte-01', brandId: 'slice', name: 'Slice Mitte (the original)', region: 'de-berlin-mitte', address: 'Torstraße 101, 10119 Berlin', lat: 52.5294, lng: 13.4014, deliveryMode: 'own_fleet', capacityPer15Min: 12, status: 'open' },
  { id: 'ber-alex-02', brandId: 'slice', name: 'Slice Alexanderplatz', region: 'de-berlin-mitte', address: 'Karl-Liebknecht-Str. 9, 10178 Berlin', lat: 52.5219, lng: 13.4132, deliveryMode: 'own_fleet', capacityPer15Min: 10, status: 'open' },
  { id: 'ber-kotti-03', brandId: 'nightowl', name: 'Night Owl Kotti', region: 'de-berlin-kreuzberg', address: 'Adalbertstraße 4, 10999 Berlin', lat: 52.4991, lng: 13.418, deliveryMode: 'third_party', capacityPer15Min: 8, status: 'open' },
  { id: 'ber-bergmann-04', brandId: 'slice', name: 'Slice Bergmannkiez', region: 'de-berlin-kreuzberg', address: 'Bergmannstraße 22, 10961 Berlin', lat: 52.4889, lng: 13.3925, deliveryMode: 'own_fleet', capacityPer15Min: 8, status: 'open' },
  { id: 'ber-kollwitz-05', brandId: 'bloom', name: 'Basil & Bloom Kollwitzplatz', region: 'de-berlin-prenzlauer', address: 'Kollwitzstraße 50, 10405 Berlin', lat: 52.5365, lng: 13.417, deliveryMode: 'own_fleet', capacityPer15Min: 6, status: 'open' },
  { id: 'ber-boxi-06', brandId: 'nightowl', name: 'Night Owl Boxhagener', region: 'de-berlin-friedrichshain', address: 'Boxhagener Str. 30, 10245 Berlin', lat: 52.5103, lng: 13.4594, deliveryMode: 'third_party', capacityPer15Min: 8, status: 'open' },
  { id: 'ber-hermann-07', brandId: 'slice', name: 'Slice Hermannplatz', region: 'de-berlin-neukoelln', address: 'Hermannplatz 6, 10967 Berlin', lat: 52.4867, lng: 13.4247, deliveryMode: 'third_party', capacityPer15Min: 10, status: 'open' },
  { id: 'ber-savigny-08', brandId: 'slice', name: 'Slice Savignyplatz', region: 'de-berlin-charlottenburg', address: 'Kantstraße 40, 10625 Berlin', lat: 52.5057, lng: 13.3209, deliveryMode: 'own_fleet', capacityPer15Min: 8, status: 'open' },
  { id: 'ber-nolle-09', brandId: 'bloom', name: 'Basil & Bloom Nollendorf', region: 'de-berlin-schoeneberg', address: 'Maaßenstraße 12, 10777 Berlin', lat: 52.4996, lng: 13.3537, deliveryMode: 'third_party', capacityPer15Min: 6, status: 'open' },
  { id: 'ber-leo-10', brandId: 'slice', name: 'Slice Wedding', region: 'de-berlin-wedding', address: 'Müllerstraße 150, 13353 Berlin', lat: 52.5467, lng: 13.3594, deliveryMode: 'own_fleet', capacityPer15Min: 8, status: 'paused' },
];

export const menu: MenuItem[] = [
  { sku: 'margherita', name: 'Margherita', description: 'San Marzano tomato, fior di latte, basil, olive oil.', category: 'pizza', basePriceCents: 950, tags: ['vegetarian', 'classic'] },
  { sku: 'diavola', name: 'Diavola', description: 'Spicy salami, chili oil, mozzarella, tomato.', category: 'pizza', basePriceCents: 1250, tags: ['spicy'] },
  { sku: 'funghi', name: 'Funghi Bianca', description: 'White base, roasted mushrooms, thyme, garlic.', category: 'pizza', basePriceCents: 1150, tags: ['vegetarian'] },
  { sku: 'bloom-garden', name: 'Bloom Garden', description: 'Cashew mozzarella, grilled courgette, peppers, pesto.', category: 'pizza', basePriceCents: 1290, tags: ['vegan'] },
  { sku: 'night-owl', name: 'Night Owl Special', description: 'Nduja, honey, burrata, rocket. After-dark favourite.', category: 'pizza', basePriceCents: 1450, tags: ['spicy', 'signature'] },
  { sku: 'pumpkin-sage', name: 'Pumpkin & Sage', description: 'Roast pumpkin, sage butter, gorgonzola. Seasonal.', category: 'pizza', basePriceCents: 1350, tags: ['vegetarian', 'seasonal'] },
  { sku: 'garlic-knots', name: 'Garlic Knots (6)', description: 'Wood-fired knots with garlic butter.', category: 'side', basePriceCents: 550, tags: ['vegetarian'] },
  { sku: 'caesar', name: 'Little Caesar Salad', description: 'Romaine, parmesan, croutons, anchovy dressing.', category: 'side', basePriceCents: 690, tags: [] },
  { sku: 'lemonade', name: 'House Lemonade', description: 'Lemon, mint, a little sparkle. 0.4 l.', category: 'drink', basePriceCents: 390, tags: ['vegan'] },
  { sku: 'tiramisu', name: 'Tiramisu', description: 'Classic, made in the Mitte kitchen every morning.', category: 'dessert', basePriceCents: 590, tags: ['vegetarian'] },
];

const pizzaSkus = menu.filter((m) => m.category === 'pizza').map((m) => m.sku);

export const campaigns = [
  { code: 'HALLOWEEN26', name: 'Halloween Spooky Slices', percentOff: 20, startsAt: '2026-10-24T00:00:00Z', endsAt: '2026-11-01T06:00:00Z', regions: null, skus: ['pumpkin-sage', 'night-owl', 'diavola'] },
  { code: 'WINTER10', name: 'Winter Warm-up', percentOff: 10, startsAt: '2026-11-15T00:00:00Z', endsAt: '2026-12-01T00:00:00Z', regions: null, skus: pizzaSkus },
  { code: 'BLACKFRI26', name: 'Black Friday Weekend', percentOff: 25, startsAt: '2026-11-27T00:00:00Z', endsAt: '2026-11-30T23:00:00Z', regions: null, skus: null },
  { code: 'XMAS26', name: 'Christmas Feast', percentOff: 15, startsAt: '2026-12-01T00:00:00Z', endsAt: '2026-12-27T00:00:00Z', regions: null, skus: null },
];

export async function seed({ reset = false } = {}) {
  await migrate();
  const pool = getPool();
  if (reset) {
    await pool.query(
      `TRUNCATE order_events, payments, deliveries, notifications, orders, consents, customer_addresses, customer_pii,
       customers, inventory, pizzeria_menu, product_signals, audit_log, vouchers, offers, offer_requests, specials,
       class_bookings, gym_classes, gyms, merchant_deals, merchants, agent_messages, agent_sessions, support_messages,
       support_cases, ads, auth_codes, customer_tokens, voice_calls, callbacks, buttons RESTART IDENTITY CASCADE`,
    );
  }
  await seedTenants();
  for (const b of brands) {
    await pool.query(
      `INSERT INTO brands (id, name, kind, tagline, accent_color) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET name=$2, kind=$3, tagline=$4, accent_color=$5`,
      [b.id, b.name, b.kind, b.tagline, b.accent],
    );
  }
  for (const m of menu) await upsertMenuItem(m);
  for (const p of pizzerias) await upsertPizzeria(p.id, p);

  // Virtual brands only sell their own signature items + shared sides/drinks.
  for (const p of pizzerias) {
    for (const m of menu) {
      const available =
        p.brandId === 'bloom'
          ? m.tags.includes('vegan') || m.category !== 'pizza'
          : p.brandId === 'nightowl'
            ? m.sku !== 'bloom-garden'
            : true;
      const override = p.region === 'de-berlin-charlottenburg' && m.category === 'pizza' ? m.basePriceCents + 50 : null;
      await pool.query(
        `INSERT INTO pizzeria_menu (pizzeria_id, sku, available, price_override_cents) VALUES ($1,$2,$3,$4)
         ON CONFLICT (pizzeria_id, sku) DO UPDATE SET available=$3, price_override_cents=$4`,
        [p.id, m.sku, available, override],
      );
    }
    const lowDough = p.id === 'ber-kotti-03';
    for (const [ingredient, qty, unit, threshold, reorder] of [
      ['dough', lowDough ? 18 : 120, 'balls', 40, 150],
      ['mozzarella', 14, 'kg', 5, 20],
      ['tomato_sauce', 20, 'l', 6, 25],
      ['basil', 2, 'kg', 0.5, 2],
    ] as const) {
      await pool.query(
        `INSERT INTO inventory (pizzeria_id, ingredient, qty, unit, reorder_threshold, reorder_qty)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (pizzeria_id, ingredient) DO UPDATE SET qty=$3`,
        [p.id, ingredient, qty, unit, threshold, reorder],
      );
    }
  }
  for (const c of campaigns) await upsertCampaign(c);

  // Canary: Kreuzberg gets the fast-delivery pricing for everyone, plus 20% of customers elsewhere.
  await setFlag('fast-delivery-pricing', { regions: ['de-berlin-kreuzberg'], percent: 20, build: 'canary' });
  await setFlag('agent-voice-ordering', { regions: ['de-berlin-mitte'], percent: 0, build: 'canary' });
  const platform = await seedPlatform();
  return {
    ...platform, brands: brands.length, pizzerias: pizzerias.length, menu: menu.length, campaigns: campaigns.length };
}

if (require.main === module) {
  seed({ reset: process.argv.includes('--reset') })
    .then((r) => console.log('Seeded', r))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
