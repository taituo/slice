import { getPool } from './pool';
import { upsertSpecial } from './platform';

/**
 * Same platform, three kinds of business:
 *  - slice    : the pizza franchise (food), branded
 *  - flexgym  : a gym chain (fitness), branded
 *  - nearby   : unbranded white-label "what's around me" — retail shops competing on offers from
 *               a shopper's GPS (e.g. inside a mall, with no mall integration), plus food + fitness
 */
export async function seedTenants() {
  const pool = getPool();
  const tenants = [
    { id: 'slice', name: 'Slice Network', verticals: ['food'], branding: { primaryColor: '#c2321f', accentColor: '#e9a23b', mood: 'playful', logoText: 'Slice' } },
    { id: 'flexgym', name: 'FlexGym', verticals: ['fitness'], branding: { primaryColor: '#0f766e', accentColor: '#a3e635', mood: 'calm', logoText: 'FlexGym' } },
    { id: 'nearby', name: 'Nearby', verticals: ['retail', 'food', 'fitness'], branding: null },
  ];
  for (const t of tenants) {
    await pool.query(
      `INSERT INTO tenants (id, name, verticals, branding) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET name=$2, verticals=$3, branding=$4`,
      [t.id, t.name, t.verticals, t.branding],
    );
  }
}

const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

// Mall of Berlin area, Leipziger Platz — shops placed a few metres apart on two levels.
const MALL = { lat: 52.5106, lng: 13.3807, place: 'Leipziger Platz mall' };

export const merchants = [
  { id: 'm-stridelab', name: 'StrideLab', category: 'shoes', dLat: 0.0001, dLng: 0.0002, theme: { primaryColor: '#111827', accentColor: '#22d3ee', mood: 'bold', logoText: 'STRIDELAB' }, maxDiscountPct: 15, policy: 'beat' },
  { id: 'm-kicks', name: 'Kicks Corner', category: 'shoes', dLat: -0.0002, dLng: 0.0001, theme: { primaryColor: '#7c2d12', accentColor: '#fb923c', mood: 'playful', logoText: 'Kicks' }, maxDiscountPct: 10, policy: 'match' },
  { id: 'm-beanthere', name: 'Bean There', category: 'coffee', dLat: 0.0003, dLng: -0.0001, theme: { primaryColor: '#3f2a1d', accentColor: '#d6a76c', mood: 'calm', logoText: 'Bean There' }, maxDiscountPct: 5, policy: 'hold' },
  { id: 'm-crema', name: 'Crema Bar', category: 'coffee', dLat: -0.0001, dLng: -0.0003, theme: { primaryColor: '#1e3a8a', accentColor: '#fde68a', mood: 'premium', logoText: 'crema' }, maxDiscountPct: 20, policy: 'beat' },
  { id: 'm-voltbox', name: 'Voltbox', category: 'electronics', dLat: 0.0002, dLng: 0.0003, theme: { primaryColor: '#18181b', accentColor: '#a3e635', mood: 'bold', logoText: 'VOLTBOX' }, maxDiscountPct: 8, policy: 'hold' },
] as const;

const deals = [
  { id: 'd-stride-run', merchant: 'm-stridelab', title: 'Trail runner GTX', category: 'shoes', keywords: ['running', 'shoes', 'trail', 'sneakers'], price: 12900, floor: 10900 },
  { id: 'd-kicks-run', merchant: 'm-kicks', title: 'Road runner 3', category: 'shoes', keywords: ['running', 'shoes', 'sneakers'], price: 11900, floor: 10500 },
  { id: 'd-bean-flat', merchant: 'm-beanthere', title: 'Flat white', category: 'coffee', keywords: ['coffee', 'flat white', 'latte'], price: 420, floor: 400 },
  { id: 'd-crema-flat', merchant: 'm-crema', title: 'Flat white + cantucci', category: 'coffee', keywords: ['coffee', 'flat white', 'latte'], price: 480, floor: 350 },
  { id: 'd-volt-buds', merchant: 'm-voltbox', title: 'Wireless earbuds', category: 'electronics', keywords: ['earbuds', 'headphones', 'audio'], price: 7900, floor: 7300 },
];

const gyms = [
  { id: 'g-mitte', name: 'FlexGym Mitte', region: 'de-berlin-mitte', address: 'Invalidenstraße 50, 10115 Berlin', lat: 52.5306, lng: 13.3835 },
  { id: 'g-kreuzberg', name: 'FlexGym Kreuzberg', region: 'de-berlin-kreuzberg', address: 'Oranienstraße 20, 10999 Berlin', lat: 52.5014, lng: 13.4187 },
  { id: 'g-studio', name: 'Studio Ruhe (partner)', region: 'de-berlin-mitte', address: 'Auguststraße 10, 10117 Berlin', lat: 52.5268, lng: 13.3969 },
];

export async function seedPlatform() {
  const pool = getPool();
  await pool.query(`UPDATE brands SET tenant_id='slice'`);

  for (const m of merchants) {
    await pool.query(
      `INSERT INTO merchants (id, tenant_id, name, category, lat, lng, place, theme, max_discount_pct, compete_policy)
       VALUES ($1,'nearby',$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET name=$2, category=$3, lat=$4, lng=$5, place=$6, theme=$7, max_discount_pct=$8, compete_policy=$9`,
      [m.id, m.name, m.category, MALL.lat + m.dLat, MALL.lng + m.dLng, MALL.place, m.theme, m.maxDiscountPct, m.policy],
    );
  }
  for (const d of deals) {
    await pool.query(
      `INSERT INTO merchant_deals (id, merchant_id, title, category, keywords, price_cents, floor_price_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET title=$3, keywords=$5, price_cents=$6, floor_price_cents=$7, stock=10, active=true`,
      [d.id, d.merchant, d.title, d.category, d.keywords, d.price, d.floor],
    );
  }

  const gymTheme = { primaryColor: '#0f766e', accentColor: '#a3e635', mood: 'calm', logoText: 'FlexGym' };
  for (const g of gyms) {
    await pool.query(
      `INSERT INTO gyms (id, tenant_id, name, region, address, lat, lng, theme) VALUES ($1,'flexgym',$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET name=$2, lat=$5, lng=$6, theme=$7`,
      [g.id, g.name, g.region, g.address, g.lat, g.lng, g.id === 'g-studio' ? { primaryColor: '#6d28d9', accentColor: '#f0abfc', mood: 'calm', logoText: 'Ruhe' } : gymTheme],
    );
  }
  // Classes are relative to seed time so the demo always has upcoming sessions.
  await pool.query(`DELETE FROM gym_classes WHERE id LIKE 'cls-%' AND NOT EXISTS (SELECT 1 FROM class_bookings b WHERE b.class_id = gym_classes.id)`);
  const classes = [
    { id: 'cls-mitte-yoga', gym: 'g-mitte', title: 'Morning flow yoga', kind: 'yoga', at: 2, dur: 60, cap: 12, price: 1500, who: 'Mia' },
    { id: 'cls-mitte-spin', gym: 'g-mitte', title: 'Spin 45', kind: 'spin', at: 4, dur: 45, cap: 2, price: 1200, who: 'Jonas' },
    { id: 'cls-xberg-hiit', gym: 'g-kreuzberg', title: 'HIIT express', kind: 'hiit', at: 3, dur: 30, cap: 10, price: 1000, who: 'Ayla' },
    { id: 'cls-xberg-yoga', gym: 'g-kreuzberg', title: 'Yin yoga', kind: 'yoga', at: 26, dur: 75, cap: 14, price: 1600, who: 'Lena' },
    { id: 'cls-studio-yoga', gym: 'g-studio', title: 'Breath & stretch', kind: 'yoga', at: 2.5, dur: 60, cap: 8, price: 1800, who: 'Tomasz' },
  ];
  for (const c of classes) {
    await pool.query(
      `INSERT INTO gym_classes (id, gym_id, title, kind, starts_at, duration_min, capacity, price_cents, instructor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET starts_at=$5, capacity=$7`,
      [c.id, c.gym, c.title, c.kind, hours(c.at), c.dur, c.cap, c.price, c.who],
    );
  }

  const specials = [
    { id: 'sp-kotti-knots', tenantId: 'slice', providerId: 'ber-kotti-03', title: 'Free garlic knots over €20', kind: 'free_item' as const, value: 0, sku: 'garlic-knots', minSubtotalCents: 2000 },
    { id: 'sp-alex-lunch', tenantId: 'slice', providerId: 'ber-alex-02', title: '15% off this week', kind: 'percent_off' as const, value: 15, sku: null, minSubtotalCents: 0 },
    { id: 'sp-studio-intro', tenantId: 'flexgym', providerId: 'g-studio', title: 'First class €5 off', kind: 'fixed_off' as const, value: 500, sku: null, minSubtotalCents: 0 },
    { id: 'sp-kicks-weekend', tenantId: 'nearby', providerId: 'm-kicks', title: '10% off running shoes', kind: 'percent_off' as const, value: 10, sku: null, minSubtotalCents: 0 },
  ];
  for (const s of specials) await upsertSpecial({ ...s, startsAt: hours(-24), endsAt: hours(24 * 30) });

  return { merchants: merchants.length, gyms: gyms.length, classes: classes.length, specials: specials.length };
}
