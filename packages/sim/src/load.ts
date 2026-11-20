/**
 * Load test with people on a map. N simulated people — diners, mall shoppers, gym-goers — walk
 * around Berlin, talk to the platform agent over A2A (each is a deep agent with its own token),
 * take competing offers, claim vouchers and walk to the shop, book classes, and sometimes complain.
 * Kitchens and couriers are simulated too; couriers ride to the door sending GPS pings.
 * Everything is streamed to the live map (web app ?view=map) and summarised in reports/load.md.
 *
 *   PEOPLE=40 DURATION_S=60 npm run load            (realistic pacing)
 *   PEOPLE=150 THINK_MS=200 DURATION_S=60 npm run load   (stress)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closePool, getPool } from '@slice/db';
import { ADMIN_KEY, API, buttonsIn, DummyCustomer, sleep, staff } from './harness';
import { runOps } from './ops';

const PEOPLE = Number(process.env.PEOPLE ?? 30);
const DURATION_S = Number(process.env.DURATION_S ?? 60);
const SEED = Number(process.env.SEED ?? 7);
const THINK_MS = Number(process.env.THINK_MS ?? 1500); // average pause between a person's actions

// Deterministic randomness so runs are comparable.
let s = SEED;
const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;

const MALL = { lat: 52.5106, lng: 13.3807 };
const AREAS = [
  { name: 'Mitte', lat: 52.5302, lng: 13.4011 },
  { name: 'Kreuzberg', lat: 52.4993, lng: 13.4184 },
  { name: 'Prenzlauer Berg', lat: 52.5365, lng: 13.417 },
  { name: 'Mall', ...MALL },
];

type Persona = 'diner' | 'shopper' | 'gymgoer' | 'browser';

interface Person {
  c: DummyCustomer;
  persona: Persona;
  state: string;
  target: { lat: number; lng: number } | null;
  pendingVoucher: { code: string; merchantId: string } | null;
  orders: string[];
}

const metrics: Record<string, number[]> = {};
const errors: Record<string, number> = {};
const counts: Record<string, number> = {};
const events: Array<{ at: string; actor: string; text: string }> = [];
const couriers = new Map<string, { lat: number; lng: number; progress: number }>();

const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
const event = (actor: string, text: string) => {
  events.push({ at: new Date().toISOString(), actor, text });
  if (events.length > 40) events.shift();
};

async function timed<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const t0 = performance.now();
  try {
    const r = await fn();
    (metrics[name] ??= []).push(performance.now() - t0);
    return r;
  } catch (err) {
    errors[name] = (errors[name] ?? 0) + 1;
    event('error', `${name}: ${(err as Error).message.slice(0, 120)}`);
    return null;
  }
}

function step(p: Person, metersPerTick = 40) {
  if (!p.target) return false;
  const dLat = p.target.lat - p.c.position.lat;
  const dLng = p.target.lng - p.c.position.lng;
  const distM = Math.hypot(dLat * 111_320, dLng * 68_000);
  if (distM <= metersPerTick) {
    p.c.position = { ...p.c.position, lat: p.target.lat, lng: p.target.lng };
    p.target = null;
    return true;
  }
  const f = metersPerTick / distM;
  p.c.position = { ...p.c.position, lat: p.c.position.lat + dLat * f, lng: p.c.position.lng + dLng * f };
  return false;
}

async function act(p: Person, merchants: Map<string, { lat: number; lng: number }>) {
  const name = p.c.opts.name;
  // Walking to the shop with a voucher: redeem on arrival.
  if (p.pendingVoucher) {
    if (step(p)) {
      const v = p.pendingVoucher;
      p.pendingVoucher = null;
      const ok = await timed('voucher_redeem', () => (staff as any).req('POST', `/v1/vouchers/${v.code}/redeem`, { merchantId: v.merchantId }));
      if (ok) {
        bump('vouchers_redeemed');
        event(name, `redeemed voucher ${v.code}`);
      }
      p.state = 'shopping done';
    }
    return;
  }
  if (p.target) {
    step(p);
    return;
  }
  if (rand() < 0.35) {
    // wander
    const a = pick(AREAS);
    p.target = { lat: a.lat + (rand() - 0.5) * 0.01, lng: a.lng + (rand() - 0.5) * 0.015 };
    p.state = `walking to ${a.name}`;
    return;
  }
  switch (p.persona) {
    case 'diner': {
      const latest = p.orders.at(-1);
      if (latest && rand() < 0.5) {
        const v = await timed('order_status', () => staff.order(latest));
        if (v?.status === 'delivered' && rand() < 0.25) {
          const r = await timed('complaint', () => p.c.say(`the pizza from ${latest} arrived cold`));
          if (r) {
            bump('complaints');
            event(name, r.reply.slice(0, 90));
          }
          p.orders.pop();
        }
        return;
      }
      const cart = pick(['2 margherita', '1 diavola and 1 tiramisu', '1 night owl and garlic knots', '3 margherita']);
      const r = await timed('offers_food', () => p.c.say(`get offers for ${cart}`));
      if (!r) return;
      bump('offer_rounds');
      const offers = buttonsIn(r.ui).filter((b) => b.action === 'choose_offer');
      if (!offers.length) return;
      const chosen = await timed('choose_food_offer', () => p.c.press('choose_offer', rand() < 0.7 ? 0 : Math.min(1, offers.length - 1)));
      const orderId = p.c.findInData((x) => x?.orderId);
      if (chosen && orderId) {
        p.orders.push(orderId);
        bump('orders');
        p.state = `waiting for ${orderId}`;
        event(name, `ordered ${cart} (${orderId})`);
      }
      return;
    }
    case 'shopper': {
      if (Math.hypot(p.c.position.lat - MALL.lat, p.c.position.lng - MALL.lng) > 0.004) {
        p.target = { lat: MALL.lat + (rand() - 0.5) * 0.0006, lng: MALL.lng + (rand() - 0.5) * 0.0008 };
        p.state = 'heading to the mall';
        return;
      }
      const want = pick(['I need running shoes', 'I want a flat white coffee', 'looking for wireless earbuds']);
      const r = await timed('offers_retail', () => p.c.say(want));
      if (!r) return;
      bump('offer_rounds');
      const offers = buttonsIn(r.ui).filter((b) => b.action === 'choose_offer');
      if (!offers.length || rand() < 0.2) return; // just browsing
      const res = await timed('claim_voucher', () => p.c.press('choose_offer', 0));
      const v = p.c.findInData((x) => (x?.code ? x : undefined));
      if (res && v) {
        const offer = (await getPool().query(`SELECT provider_id FROM offers WHERE id=$1`, [offers[0]!.context.offerId])).rows[0];
        const m = merchants.get(offer.provider_id)!;
        p.pendingVoucher = { code: v.code, merchantId: offer.provider_id };
        p.target = m;
        p.state = `walking to ${v.providerName}`;
        bump('vouchers');
        event(name, `claimed ${v.headline} at ${v.providerName} for €${(v.priceCents / 100).toFixed(2)}`);
      }
      return;
    }
    case 'gymgoer': {
      const r = await timed('find_classes', () => p.c.say(pick(['find me a yoga class', 'any spin class today?', 'hiit class nearby'])));
      if (!r) return;
      const books = buttonsIn(r.ui).filter((b) => b.action === 'book_class');
      if (!books.length || rand() < 0.4) return;
      const b = await timed('book_class', () => p.c.press('book_class', Math.floor(rand() * books.length)));
      if (b) {
        bump(/waitlist/.test(b.reply) ? 'waitlisted' : 'bookings');
        event(name, b.reply.slice(0, 90));
      }
      return;
    }
    case 'browser': {
      const r = await timed('browse', () => p.c.say(pick(['show me the menu', 'what shops are around here', 'which pizzeria is closest'])));
      if (r) bump('browses');
      return;
    }
  }
}

function pct(xs: number[], p: number) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function main() {
  const merchants = new Map<string, { lat: number; lng: number }>(
    (await getPool().query(`SELECT id, lat, lng FROM merchants`)).rows.map((m) => [m.id, { lat: m.lat, lng: m.lng }]),
  );
  console.log(`Signing in ${PEOPLE} people…`);
  const people: Person[] = [];
  const personas: Persona[] = ['diner', 'diner', 'shopper', 'shopper', 'gymgoer', 'browser'];
  const runId = Date.now().toString().slice(-6);
  for (let i = 0; i < PEOPLE; i++) {
    const persona = personas[i % personas.length]!;
    const area = persona === 'shopper' ? pick(AREAS) : pick(AREAS.slice(0, 3));
    const c = new DummyCustomer({
      name: `${persona}-${i}`,
      phone: `+49170${runId}${String(i).padStart(3, '0')}`,
      tenant: 'nearby',
      position: { lat: area.lat + (rand() - 0.5) * 0.02, lng: area.lng + (rand() - 0.5) * 0.03, addressLine: `${area.name} (simulated)` },
    });
    await c.signIn();
    people.push({ c, persona, state: 'idle', target: null, pendingVoucher: null, orders: [] });
  }

  let stop = false;
  const started = Date.now();
  const ops = runOps(
    {
      stepMs: 1500,
      rejectRate: 0.08,
      courierFailRate: 0.03,
      pingsPerTrip: 6,
      rand,
      onCourier: (x) => (x.progress >= 1 ? couriers.delete(x.orderId) : couriers.set(x.orderId, x)),
      onEvent: (t) => event('ops', t),
    },
    () => stop,
  );

  const publish = setInterval(() => {
    const snapshot = {
      at: new Date().toISOString(),
      actors: [
        ...people.map((p) => ({ id: p.c.opts.name, kind: 'customer', lat: p.c.position.lat, lng: p.c.position.lng, state: p.state, persona: p.persona, target: p.target })),
        ...[...couriers.entries()].map(([id, c]) => ({ id: `courier-${id.slice(-6)}`, kind: 'courier', lat: c.lat, lng: c.lng, state: `${Math.round(c.progress * 100)}%` })),
      ],
      stats: { ...counts, elapsedS: Math.round((Date.now() - started) / 1000), people: PEOPLE, requests: Object.values(metrics).reduce((n, x) => n + x.length, 0), errors: Object.values(errors).reduce((n, x) => n + x, 0) },
      events,
    };
    fetch(`${API}/v1/sim/state`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY }, body: JSON.stringify(snapshot) }).catch(() => undefined);
  }, 1000);

  console.log(`Running for ${DURATION_S}s…`);
  await Promise.all(
    people.map(async (p, i) => {
      await sleep(i * 150);
      while (Date.now() - started < DURATION_S * 1000) {
        await act(p, merchants);
        await sleep(THINK_MS * (0.4 + rand() * 1.2));
      }
    }),
  );
  stop = true;
  clearInterval(publish);
  await ops;

  const { rows: outcome } = await getPool().query(
    `SELECT status, count(*)::int AS n FROM orders WHERE created_at > to_timestamp($1 / 1000.0) GROUP BY status ORDER BY status`,
    [started],
  );
  const { rows: refunds } = await getPool().query(
    `SELECT count(*)::int AS cases, coalesce(sum(credit_cents),0)::int AS cents FROM support_cases WHERE created_at > to_timestamp($1 / 1000.0)`,
    [started],
  );
  const totalReq = Object.values(metrics).reduce((n, x) => n + x.length, 0);
  const totalErr = Object.values(errors).reduce((n, x) => n + x, 0);
  const md = [
    `# Load test — ${PEOPLE} people, ${DURATION_S} s, ~${THINK_MS} ms think time`,
    '',
    `Run ${new Date().toISOString()} against ${API} (seed ${SEED}). ${totalReq} agent/API calls, ${totalErr} errors (${((totalErr / Math.max(1, totalReq + totalErr)) * 100).toFixed(1)}%), ${(totalReq / DURATION_S).toFixed(1)} calls/s.`,
    '',
    '| Action | Calls | p50 ms | p95 ms | p99 ms | Errors |',
    '| --- | --- | --- | --- | --- | --- |',
    ...Object.entries(metrics)
      .sort()
      .map(([k, xs]) => `| ${k} | ${xs.length} | ${pct(xs, 50).toFixed(0)} | ${pct(xs, 95).toFixed(0)} | ${pct(xs, 99).toFixed(0)} | ${errors[k] ?? 0} |`),
    '',
    '| Outcome | Count |',
    '| --- | --- |',
    ...Object.entries(counts).sort().map(([k, v]) => `| ${k.replace(/_/g, ' ')} | ${v} |`),
    ...outcome.map((o) => `| orders ${o.status} | ${o.n} |`),
    `| support cases | ${refunds[0].cases} |`,
    `| refunds and credits | €${(refunds[0].cents / 100).toFixed(2)} |`,
    '',
    'Orders still in flight when the run ends finish on their own; the workflows are durable.',
  ].join('\n');
  mkdirSync(join(process.cwd(), 'reports'), { recursive: true });
  writeFileSync(join(process.cwd(), 'reports', process.env.REPORT ?? 'load.md'), md);
  console.log(md);
  await closePool();
}

main().catch(async (e) => {
  console.error(e);
  await closePool();
  process.exit(1);
});
