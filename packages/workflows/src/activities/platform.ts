import * as repo from '@slice/db';
import { runDeepAgent, llmFromEnv, type AgentDef, type Memory } from '@slice/agents';
import {
  assignVariant,
  bestSpecial,
  checkAdCopy,
  idleDiscountPct,
  priceCart,
  rankOffers,
  variantsToPause,
  type CartLine,
  type OfferDraft,
  type RankedOffer,
  type Theme,
  type Vertical,
} from '@slice/shared';
import { ApplicationFailure } from '@temporalio/common';
import { getTemporalClient } from '../temporal';
import { ElevenLabsVoice } from '../adapters/voice';
import { requestCallback } from '../callbacks';
import type { ActivityDeps } from './index';

export interface OfferRequestInput {
  requestId: string;
  tenantId: string;
  vertical: Vertical;
  lat: number;
  lng: number;
  query?: string;
  items?: CartLine[];
  customerKey: string;
}

export interface Candidate {
  vertical: Vertical;
  providerId: string;
  agentUrl?: string | null;
  /** Food: the kitchen as seen at auction start (distance, load, ETA), so quotes don't re-query it. */
  snapshot?: import('@slice/shared').NearbyPizzeria;
}

const brandTheme = (accent: string, name: string, kind: string): Theme => ({
  primaryColor: accent,
  accentColor: '#e9a23b',
  mood: kind === 'virtual' ? 'bold' : 'playful',
  logoText: name,
});

/** Activities for the platform services. Same factory style as order activities. */
export function createPlatformActivities(deps: ActivityDeps) {
  return {
    // ---------------------------------------------------------------- offers

    async findOfferCandidates(input: OfferRequestInput): Promise<Candidate[]> {
      if (input.vertical === 'food') {
        const near = await repo.findNearestPizzerias({ lat: input.lat, lng: input.lng }, { limit: 6, radiusKm: 8 });
        // A kitchen with no free oven slot doesn't bid: an offer it can't cook would only fail later.
        return near.filter((p) => p.activeOrders < p.capacityPer15Min).map((p) => ({ vertical: 'food' as const, providerId: p.id, snapshot: p }));
      }
      if (input.vertical === 'fitness') {
        const cls = await repo.classesNear(input.lat, input.lng, { kind: kindFrom(input.query), withinHours: 48 });
        return [...new Set(cls.map((c) => c.gymId))].map((g) => ({ vertical: 'fitness' as const, providerId: g }));
      }
      const merchants = await repo.merchantsNear(input.lat, input.lng, 400);
      return merchants.map((m) => ({ vertical: 'retail' as const, providerId: m.id, agentUrl: m.offerAgentUrl }));
    },

    /** One provider answers. Retail merchants with their own A2A agent are asked over A2A first. */
    async quoteCandidate(input: OfferRequestInput & { candidate: Candidate }): Promise<OfferDraft[]> {
      const c = input.candidate;
      if (c.vertical === 'food') return quoteFood(input, c.providerId, deps.now(), c.snapshot);
      if (c.vertical === 'fitness') return quoteFitness(input, c.providerId, deps.now());
      if (c.agentUrl) {
        try {
          return await quoteViaA2a(c.agentUrl, input, c.providerId);
        } catch {
          /* their agent is down: fall back to the merchant's standing policy */
        }
      }
      return quoteRetail(input, c.providerId, deps.now());
    },

    async saveOffers(input: { requestId: string; offers: RankedOffer[]; ttlSeconds: number }) {
      return repo.saveOffers(input.requestId, input.offers, input.ttlSeconds);
    },

    async expireVoucher(input: { code: string }) {
      return repo.setVoucherStatus(input.code, 'expired');
    },

    // ---------------------------------------------------------------- fitness bookings

    async reserveSpot(input: { bookingId: string }) {
      return repo.reserveSpot(input.bookingId);
    },
    async setBookingStatus(input: { bookingId: string; status: string }) {
      await repo.setBookingStatus(input.bookingId, input.status);
    },
    /** Give the freed spot to the next person and tell their booking workflow (signal from the client side). */
    async promoteFromWaitlist(input: { classId: string }) {
      const next = await repo.promoteFromWaitlist(input.classId);
      if (next) {
        await (await getTemporalClient()).workflow.getHandle(next).signal('promoted').catch(() => undefined);
      }
      return next;
    },

    // ---------------------------------------------------------------- support

    async triageCase(input: { caseId: string; message: string; orderId?: string | null }): Promise<Triage> {
      const order = input.orderId ? await repo.getOrder(input.orderId) : null;
      const events = input.orderId ? await repo.listOrderEvents(input.orderId) : [];
      const triage = triagePolicy(input.message, order, events, deps.now());
      await repo.updateSupportCase(input.caseId, { status: 'triaged', category: triage.category });
      return triage;
    },
    async supportMessage(input: { caseId: string; author: 'agent' | 'system' | 'human' | 'customer'; body: string }) {
      await repo.addSupportMessage(input.caseId, input.author, input.body);
    },
    async setCaseStatus(input: { caseId: string; status: string; resolution?: string; creditCents?: number; csat?: number }) {
      await repo.updateSupportCase(input.caseId, input);
    },
    /** Refund to the original payment, or a credit voucher when there was no captured payment. */
    async applyResolution(input: { caseId: string; orderId?: string | null; action: 'refund' | 'credit'; amountCents: number }) {
      if (input.action === 'refund' && input.orderId) {
        const pool = repo.getPool();
        const pay = await pool.query(`SELECT provider_ref, status FROM payments WHERE order_id=$1`, [input.orderId]);
        if (pay.rows[0]?.status === 'captured') {
          await deps.payments.refund(pay.rows[0].provider_ref, input.amountCents);
          await pool.query(`UPDATE payments SET refunded_cents = refunded_cents + $2, updated_at=now() WHERE order_id=$1`, [input.orderId, input.amountCents]);
        }
      }
      await repo.updateSupportCase(input.caseId, { creditCents: input.amountCents });
      return { ok: true };
    },

    // ---------------------------------------------------------------- ads

    async generateAds(): Promise<{ created: number; rejected: number; total: number }> {
      const ops = await adOpportunities(deps.now());
      const llm = llmFromEnv();
      let created = 0;
      let rejected = 0;
      for (const op of ops) {
        const variants = llm ? await llmCopy(llm, op).catch(() => templateCopy(op)) : templateCopy(op);
        for (const [i, v] of variants.entries()) {
          const problems = checkAdCopy(v, { percentOff: op.percentOff });
          const copy = problems.length ? templateCopy(op)[i] ?? templateCopy(op)[0]! : v;
          if (problems.length) rejected++;
          const inserted = await repo.upsertAd({
            id: repo.newId('ad'),
            tenantId: op.tenantId,
            sourceKey: op.key,
            variant: String.fromCharCode(97 + i),
            providerId: op.providerId,
            headline: copy.headline,
            body: copy.body,
            cta: copy.cta,
            lat: op.lat,
            lng: op.lng,
            theme: op.theme,
            status: 'active',
            generatedBy: llm && !problems.length ? llm.name : 'template',
            expiresAt: op.expiresAt,
          });
          if (inserted) created++;
        }
      }
      return { created, rejected, total: ops.length };
    },

    async pruneAds(input: { minImpressions?: number } = {}): Promise<{ paused: string[] }> {
      await repo.expireAds();
      const ads = (await repo.listAds()).filter((a) => a.status === 'active');
      const groups = new Map<string, typeof ads>();
      for (const a of ads) groups.set(a.sourceKey, [...(groups.get(a.sourceKey) ?? []), a]);
      const paused: string[] = [];
      for (const g of groups.values()) paused.push(...variantsToPause(g, input.minImpressions ?? 200));
      await repo.setAdStatus(paused, 'paused');
      return { paused };
    },

    // ---------------------------------------------------------------- agents

    /** Async A2A tasks: the API owns the agent definitions, so the durable task calls its internal endpoint. */
    async runAgentTurn(input: { tenantId: string; sessionId: string; text: string; customerToken?: string | null }) {
      const res = await fetch(`${process.env.API_URL ?? 'http://localhost:4000'}/v1/internal/agent-turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-key': process.env.INTERNAL_API_KEY ?? 'dev-internal-key' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`agent turn failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as { reply: string; ui: unknown[]; toolCalls: unknown[] };
    },

    /** Development deep agent: turns a cluster of usage signals into an implementable issue. */
    async draftIssueWithDevAgent(input: { key: string; kind: string; count: number; samples: string[] }) {
      const result = await runDeepAgent(
        devAgent,
        { sessionId: `dev-${input.key}`, text: JSON.stringify(input) },
        { tenantId: 'platform', sessionId: `dev-${input.key}`, channel: 'dev', customerId: null, a2ui: false },
        { llm: llmFromEnv(), memory: noMemory },
      );
      return { title: `[usage] ${input.key} (${input.count}×)`, body: result.reply, engine: result.engine };
    },
  };
}

// ------------------------------------------------------------------ offers: per-vertical pricing policies

function kindFrom(query?: string): string | undefined {
  const q = (query ?? '').toLowerCase();
  return ['yoga', 'spin', 'hiit', 'strength'].find((k) => q.includes(k));
}

async function quoteFood(input: OfferRequestInput, pizzeriaId: string, now: Date, snapshot?: import('@slice/shared').NearbyPizzeria): Promise<OfferDraft[]> {
  const items = input.items ?? [];
  if (!items.length) return [];
  const p = snapshot ?? (await repo.findNearestPizzerias({ lat: input.lat, lng: input.lng }, { limit: 10, radiusKm: 8 })).find((x) => x.id === pizzeriaId);
  if (!p || p.activeOrders >= p.capacityPer15Min) return [];
  const [{ items: menu, overrides }, campaigns, flag, specials, brands] = await Promise.all([
    repo.getMenu(p.id),
    repo.listCampaigns(now),
    repo.getFlag('fast-delivery-pricing'),
    repo.specialsFor([p.id], now),
    repo.listBrands(),
  ]);
  if (items.some((i) => !menu.find((m) => m.sku === i.sku))) return []; // this kitchen doesn't sell it
  const quote = priceCart(items, menu, {
    now,
    region: p.region,
    distanceKm: p.distanceKm,
    campaigns,
    overrides,
    experimentVariant: assignVariant(flag, input.customerKey, p.region),
  });
  const spare = idleDiscountPct(p.activeOrders, p.capacityPer15Min);
  const freeValue = (sku: string | null) => menu.find((m) => m.sku === sku)?.basePriceCents ?? 0;
  const sp = bestSpecial(quote.subtotalCents, specials[p.id] ?? [], now, freeValue(specials[p.id]?.find((s) => s.kind === 'free_item')?.sku ?? null));
  const idleCents = Math.round(((quote.subtotalCents - quote.discountCents) * spare) / 100);
  const extra = (sp?.discountCents ?? 0) + idleCents;
  const brand = brands.find((b: any) => b.id === p.brandId);
  const isVirtual = brand?.kind === 'virtual';
  const price = Math.max(0, quote.totalCents - (sp && sp.special.kind !== 'free_item' ? sp.discountCents : 0) - idleCents);
  return [
    {
      vertical: 'food',
      providerId: p.id,
      providerName: p.name,
      listPriceCents: quote.totalCents,
      priceCents: price,
      etaMinutes: p.etaMinutes,
      distanceM: Math.round(p.distanceKm * 1000),
      headline: `${items.map((i) => `${i.qty}× ${menu.find((m) => m.sku === i.sku)!.name}`).join(', ')} from ${p.brandName}`,
      specialTitle: sp?.special.title ?? (spare ? `Ovens free now: ${spare}% off` : null),
      theme: brandTheme(brand?.accentColor ?? '#c2321f', p.brandName, brand?.kind ?? 'real'),
      details: {
        pizzeriaId: p.id,
        items,
        quote: { ...quote, discountCents: quote.discountCents + (quote.totalCents - price), totalCents: price },
        freeItem: sp?.special.kind === 'free_item' ? sp.special.sku : null,
        extraDiscountCents: extra,
      },
      // Virtual brands compete harder: they may match a rival down to 90% of their price.
      floorPriceCents: isVirtual ? Math.round(price * 0.9) : price,
      competePolicy: isVirtual ? 'match' : 'hold',
      round: 1,
    },
  ];
}

async function quoteFitness(input: OfferRequestInput, gymId: string, now: Date): Promise<OfferDraft[]> {
  const classes = (await repo.classesNear(input.lat, input.lng, { kind: kindFrom(input.query), withinHours: 48 })).filter((c) => c.gymId === gymId);
  const specials = await repo.specialsFor([gymId], now);
  return classes.slice(0, 3).map((c) => {
    const sp = bestSpecial(c.priceCents, specials[gymId] ?? [], now);
    const price = c.priceCents - (sp?.discountCents ?? 0);
    const when = new Date(c.startsAt);
    const minutes = Math.max(0, Math.round((when.getTime() - now.getTime()) / 60000));
    return {
      vertical: 'fitness' as const,
      providerId: gymId,
      providerName: c.gymName,
      listPriceCents: c.priceCents,
      priceCents: price,
      etaMinutes: minutes,
      distanceM: Math.round(metersTo(input, c)),
      headline: `${c.title} with ${c.instructor}, ${when.toISOString().slice(11, 16)} UTC`,
      specialTitle: sp?.special.title ?? (c.spotsLeft === 0 ? 'Full: you would join the waitlist' : `${c.spotsLeft} spots left`),
      theme: c.theme,
      details: { classId: c.id, startsAt: c.startsAt, spotsLeft: c.spotsLeft, kind: c.kind },
      floorPriceCents: price,
      competePolicy: 'hold' as const,
      round: 1,
    };
  });
}

async function quoteRetail(input: OfferRequestInput, merchantId: string, now: Date): Promise<OfferDraft[]> {
  const [m] = (await repo.merchantsNear(input.lat, input.lng, 400)).filter((x) => x.id === merchantId);
  if (!m) return [];
  const deals = await repo.dealsFor([m.id], input.query ?? '');
  const specials = await repo.specialsFor([m.id], now);
  return deals.map((d) => {
    const sp = bestSpecial(d.priceCents, specials[m.id] ?? [], now);
    const price = d.priceCents - (sp?.discountCents ?? 0);
    const floor = Math.max(d.floorPriceCents, Math.round(d.priceCents * (1 - m.maxDiscountPct / 100)));
    return {
      vertical: 'retail' as const,
      providerId: m.id,
      providerName: m.name,
      listPriceCents: d.priceCents,
      priceCents: price,
      etaMinutes: null,
      distanceM: Math.round(metersTo(input, m)),
      headline: d.title,
      specialTitle: sp?.special.title ?? null,
      theme: m.theme,
      details: { dealId: d.id, place: m.place, category: d.category },
      floorPriceCents: Math.min(floor, price),
      competePolicy: m.competePolicy,
      round: 1,
    };
  });
}

/** Ask a merchant's own agent over A2A for a structured quote (data part in, data part out). */
async function quoteViaA2a(url: string, input: OfferRequestInput, providerId: string): Promise<OfferDraft[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: input.requestId,
        method: 'message/send',
        params: { message: { role: 'user', messageId: input.requestId, parts: [{ kind: 'data', data: { rfq: { query: input.query, lat: input.lat, lng: input.lng } } }] } },
      }),
    });
    const body = (await res.json()) as any;
    const offers = (body.result?.parts ?? []).flatMap((p: any) => (p.kind === 'data' && Array.isArray(p.data?.offers) ? p.data.offers : []));
    return offers.map((o: any) => ({ ...o, providerId, vertical: 'retail', round: 1 }));
  } finally {
    clearTimeout(timer);
  }
}

function metersTo(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ------------------------------------------------------------------ support policy

export interface Triage {
  category: 'late' | 'missing_item' | 'wrong_item' | 'quality' | 'billing' | 'booking' | 'voucher' | 'other';
  action: 'credit' | 'refund' | 'none' | 'escalate';
  amountCents: number;
  autoApprove: boolean;
  reply: string;
}

/**
 * Written support policy, applied the same way on every channel. Small, clear-cut problems are fixed
 * instantly; anything bigger goes to a person with the facts attached.
 */
export function triagePolicy(message: string, order: repo.OrderRow | null, events: Array<{ type: string; at: string }>, now: Date): Triage {
  const m = message.toLowerCase();
  const total = order?.totalCents ?? 0;
  const category: Triage['category'] = /late|where is|still waiting|taking (so|too) long|hasn't arrived|not arrived|never arrived|never came/.test(m)
    ? 'late'
    : /missing|forgot|didn't get|did not get/.test(m)
      ? 'missing_item'
      : /wrong/.test(m)
        ? 'wrong_item'
        : /cold|burnt|burned|soggy|bad|raw/.test(m)
          ? 'quality'
          : /charge|refund|paid twice|double/.test(m)
            ? 'billing'
            : /class|booking|waitlist/.test(m)
              ? 'booking'
              : /voucher|code/.test(m)
                ? 'voucher'
                : 'other';

  if (category === 'late' && order) {
    const start = Date.parse(events[0]?.at ?? order.createdAt);
    const end = order.status === 'delivered' ? Date.parse(events.find((e) => e.type === 'delivered')?.at ?? now.toISOString()) : now.getTime();
    const minutes = Math.round((end - start) / 60000);
    if (order.status === 'failed' || minutes > 60) {
      return { category, action: 'credit', amountCents: 500, autoApprove: true, reply: `Sorry about the wait (${minutes} min). I've added a €5.00 credit to your account.` };
    }
    return { category, action: 'none', amountCents: 0, autoApprove: true, reply: `Your order is ${order.status.replace(/_/g, ' ')}. It's within our normal time; I'll keep an eye on it.` };
  }
  if ((category === 'missing_item' || category === 'wrong_item' || category === 'quality') && order) {
    const share = category === 'quality' ? 0.3 : 0.4;
    const amount = Math.round(total * share);
    const limit = category === 'quality' ? 1000 : 1500;
    return amount <= limit
      ? { category, action: 'refund', amountCents: amount, autoApprove: true, reply: `I'm sorry. I've refunded €${(amount / 100).toFixed(2)} to your original payment.` }
      : { category, action: 'refund', amountCents: amount, autoApprove: false, reply: `I'm sorry. A refund of €${(amount / 100).toFixed(2)} needs a quick check by our team; you'll hear back within 15 minutes.` };
  }
  return { category, action: 'escalate', amountCents: 0, autoApprove: false, reply: 'Thanks for telling us. A person from our team is taking this over and will reply shortly.' };
}

// ------------------------------------------------------------------ ads

interface AdOpportunity {
  key: string;
  tenantId: string;
  providerId: string | null;
  name: string;
  what: string;
  percentOff: number | null;
  lat: number | null;
  lng: number | null;
  theme: Theme;
  expiresAt: string;
  cta: string;
}

async function adOpportunities(now: Date): Promise<AdOpportunity[]> {
  const pool = repo.getPool();
  const ops: AdOpportunity[] = [];
  const inHours = (h: number) => new Date(now.getTime() + h * 3600_000).toISOString();
  const providers = (
    await pool.query(
      `SELECT p.id, p.name, p.lat, p.lng, b.accent_color AS color, b.name AS brand, b.kind, 'slice' AS tenant, NULL::jsonb AS theme FROM pizzerias p JOIN brands b ON b.id=p.brand_id
       UNION ALL SELECT g.id, g.name, g.lat, g.lng, NULL, g.name, 'real', g.tenant_id, g.theme FROM gyms g
       UNION ALL SELECT m.id, m.name, m.lat, m.lng, NULL, m.name, 'real', m.tenant_id, m.theme FROM merchants m`,
    )
  ).rows;
  const byId = new Map(providers.map((p) => [p.id, p]));
  const themeOf = (p: any): Theme => p.theme ?? brandTheme(p.color ?? '#c2321f', p.brand, p.kind);

  for (const s of await repo.listActiveSpecials(now)) {
    const p = byId.get(s.providerId);
    if (!p) continue;
    ops.push({
      key: `special:${s.id}`,
      tenantId: s.tenantId,
      providerId: s.providerId,
      name: p.name,
      what: s.title,
      percentOff: s.kind === 'percent_off' ? s.value : null,
      lat: p.lat,
      lng: p.lng,
      theme: themeOf(p),
      expiresAt: s.endsAt,
      cta: 'See the offer',
    });
  }
  const idle = await pool.query(
    `SELECT p.id FROM pizzerias p WHERE p.status='open' AND NOT EXISTS (
       SELECT 1 FROM orders o WHERE o.pizzeria_id=p.id AND o.status IN ('routed','payment_authorized','accepted','preparing','ready'))`,
  );
  for (const r of idle.rows) {
    const p = byId.get(r.id);
    ops.push({ key: `idle:${r.id}`, tenantId: 'slice', providerId: r.id, name: p.name, what: 'No queue at the oven right now', percentOff: null, lat: p.lat, lng: p.lng, theme: themeOf(p), expiresAt: inHours(1), cta: 'Order now' });
  }
  const soon = await pool.query(
    `SELECT c.id, c.title, c.gym_id, c.starts_at, c.capacity - (SELECT count(*) FROM class_bookings b WHERE b.class_id=c.id AND b.status='confirmed') AS free
     FROM gym_classes c WHERE c.starts_at BETWEEN now() AND now() + interval '6 hours'`,
  );
  for (const r of soon.rows) {
    if (Number(r.free) <= 0) continue;
    const p = byId.get(r.gym_id);
    ops.push({
      key: `class:${r.id}`,
      tenantId: p.tenant,
      providerId: r.gym_id,
      name: p.name,
      what: `${r.title} at ${new Date(r.starts_at).toISOString().slice(11, 16)} UTC, ${r.free} spots left`,
      percentOff: null,
      lat: p.lat,
      lng: p.lng,
      theme: themeOf(p),
      expiresAt: new Date(r.starts_at).toISOString(),
      cta: 'Book a spot',
    });
  }
  return ops;
}

function templateCopy(op: AdOpportunity) {
  const short = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
  return [
    { headline: short(op.what, 60), body: short(`At ${op.name}, a few minutes from you.`, 140), cta: op.cta },
    { headline: short(`${op.name}: ${op.what}`, 60), body: short('Tap to see it and order or book in one step.', 140), cta: op.cta },
  ];
}

async function llmCopy(llm: NonNullable<ReturnType<typeof llmFromEnv>>, op: AdOpportunity) {
  const msg = await llm.chat(
    [
      { role: 'system', content: 'Write 2 short ad variants as JSON {"variants":[{"headline","body","cta"}]}. Headline ≤ 60 chars, body ≤ 140, CTA ≤ 24. Only state the facts given. No superlatives.' },
      { role: 'user', content: JSON.stringify({ business: op.name, fact: op.what, percentOff: op.percentOff, cta: op.cta }) },
    ],
    [],
  );
  const json = JSON.parse((msg.content ?? '').replace(/^```json|```$/g, '').trim());
  return (json.variants as Array<{ headline: string; body: string; cta: string }>).slice(0, 2);
}

// ------------------------------------------------------------------ development agent

const noMemory: Memory = { load: async () => [], append: async () => {}, savePlan: async () => {} };

const MODULE_MAP: Record<string, string[]> = {
  food: ['packages/api/src/verticals/food.ts', 'packages/workflows/src/workflows/order.ts', 'packages/db/src/repo.ts'],
  fitness: ['packages/api/src/verticals/fitness.ts', 'packages/workflows/src/workflows/booking.ts'],
  retail: ['packages/api/src/verticals/retail.ts', 'packages/workflows/src/activities/platform.ts'],
  support: ['packages/workflows/src/workflows/support.ts', 'packages/workflows/src/activities/platform.ts (triagePolicy)'],
  payments: ['packages/workflows/src/adapters/payments.ts'],
  agent: ['packages/api/src/agents.ts', 'packages/agents/src/index.ts'],
};

export const devAgent: AgentDef = {
  id: 'dev',
  name: 'Development agent',
  description: 'turns usage signals into implementable issues',
  instructions:
    'You are the development agent of a multi-vertical commerce platform (food, fitness, retail) built on TypeScript, Temporal and Postgres. Given a cluster of usage signals, write a GitHub issue body in markdown with: Problem (with counts), Proposal, Files to change, Feature flag name (default off), Acceptance tests, Rollout (canary regions first). Be concrete and brief.',
  tools: [],
  fallback: async ({ text }) => {
    const c = JSON.parse(text) as { key: string; kind: string; count: number; samples: string[] };
    const theme = c.key.split(':').slice(1).join(':') || 'general';
    const area =
      Object.keys(MODULE_MAP).find((k) => theme.includes(k)) ??
      (/pay|card|wallet|mobilepay/.test(theme) ? 'payments' : /gluten|vegan|menu|pizza/.test(theme) ? 'food' : /class|gym|yoga/.test(theme) ? 'fitness' : /shop|mall|voucher/.test(theme) ? 'retail' : 'agent');
    const flag = theme.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40);
    const body = [
      `## Problem`,
      `${c.count} ${c.kind.replace(/_/g, ' ')} signals about **${theme}** this period. Samples:`,
      ...c.samples.map((s) => `- \`${s}\``),
      ``,
      `## Proposal`,
      `Support "${theme}" end to end in the ${area} domain, available to the agent, A2A, MCP and voice through the shared tool catalogue.`,
      ``,
      `## Files to change`,
      ...(MODULE_MAP[area] ?? MODULE_MAP.agent!).map((f) => `- ${f}`),
      `- packages/shared/src/tools.ts (if a new tool is needed)`,
      ``,
      `## Feature flag`,
      `\`${flag}\`, default off.`,
      ``,
      `## Acceptance tests`,
      `- A unit or workflow test covering the new behaviour`,
      `- An e2e check in scripts/e2e.ts: the agent no longer reports "${theme}" as unmet`,
      ``,
      `## Rollout`,
      `Canary regions first via canary-release.yml; ramp 25 → 50 → 100% if the health gate passes.`,
    ].join('\n');
    return { reply: body, ui: [], toolCalls: [] };
  },
};

// ------------------------------------------------------------------ AI callbacks

/** Milliseconds until a call is allowed, given quiet hours in the button owner's time zone. */
export function quietDelayMs(quiet: { from: number; to: number; timezone: string } | null | undefined, now: Date): number {
  if (!quiet || quiet.from === quiet.to) return 0;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: quiet.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const minutesNow = get('hour') * 60 + get('minute') + get('second') / 60;
  const from = quiet.from * 60;
  const to = quiet.to * 60;
  const inside = from < to ? minutesNow >= from && minutesNow < to : minutesNow >= from || minutesNow < to;
  if (!inside) return 0;
  const until = (to - minutesNow + 24 * 60) % (24 * 60);
  return Math.round(until * 60_000);
}

export function createCallbackActivities(deps: ActivityDeps) {
  return {
    async quietDelay(input: { quiet: { from: number; to: number; timezone: string } | null }) {
      return quietDelayMs(input.quiet, deps.now());
    },
    async updateCallback(input: { callbackId: string; status?: string; attempts?: number; scheduledFor?: string | null; conversationId?: string | null; context?: unknown; outcome?: string; presses?: number }) {
      const { callbackId, ...patch } = input;
      await repo.updateCallback(callbackId, patch);
    },
    async openOfferRequest(input: { requestId: string; tenantId: string; customerId: string; lat: number; lng: number; items: unknown }) {
      await repo.createOfferRequest({ id: input.requestId, tenantId: input.tenantId, vertical: 'food', customerKey: input.customerId, lat: input.lat, lng: input.lng, request: { items: input.items }, preference: 'best_value' });
    },
    async callbackContext(input: { customerId: string }) {
      return repo.customerContext(input.customerId);
    },
    /** Dial through ElevenLabs. Dry run (no keys) still yields a conversation id so the flow is testable. */
    async placeCallbackCall(input: { callbackId: string; customerId: string; purpose: string; opener: string; variables: Record<string, string | number> }) {
      const contact = await repo.getCustomerContact(input.customerId);
      if (!contact?.phone) return { conversationId: null, dryRun: true, reachable: false };
      const voice = new ElevenLabsVoice();
      const r = await voice.call({ to: contact.phone, purpose: input.purpose, variables: { callback_ref: input.callbackId, opener: input.opener, ...input.variables } });
      const conversationId = r.conversationId ?? `dryrun_${input.callbackId}_${Date.now().toString(36)}`;
      await repo.logVoiceCall({ provider: 'elevenlabs', direction: 'outbound', conversationId, recipient: `customer:${input.customerId}`, purpose: input.purpose, status: r.dryRun ? 'dry_run' : 'initiated' });
      return { conversationId, dryRun: r.dryRun, reachable: true };
    },
    /** Put the reason for the call into the agent's memory, so the conversation starts in context. */
    /** The system asks for a callback on its own (e.g. a support case missed its SLA). */
    async requestCallback(input: { customerId: string; tenantId: string; reason: string }) {
      return requestCallback({ customerId: input.customerId, tenantId: input.tenantId, source: `system:${input.reason}`, intent: 'support_followup', reason: input.reason });
    },
    async seedCallbackSession(input: { sessionId: string; tenantId: string; customerId: string; opener: string; note: string }) {
      await repo.ensureSession(input.sessionId, input.tenantId, 'voice', input.customerId);
      await repo.appendMessage(input.sessionId, 'assistant', `${input.opener} ${input.note}`.trim());
    },
  };
}
