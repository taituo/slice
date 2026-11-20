import * as repo from '@slice/db';
import { llmFromEnv, runDeepAgent, type AgentDef, type Memory, type ToolContext, type ToolResult, type ToolSpec } from '@slice/agents';
import {
  formatEur,
  toolCatalog,
  toolJsonSchema,
  type A2uiAction,
  type AgentToolName,
  type ToolDomain,
} from '@slice/shared';
import * as platform from './platform';
import * as svc from './services';
import { caseUi, classesUi, menuUi, offersUi, trackerUi, voucherUi } from './ui';

/**
 * Agents of the platform. One concierge per tenant, composed from vertical specialists (food,
 * fitness, retail) plus support. The same definitions answer the web chat, A2A, MCP-style tool
 * calls and the ElevenLabs voice line.
 */

type Impl = (args: any, ctx: ToolContext) => Promise<ToolResult>;

const impls: Record<AgentToolName, Impl> = {
  async request_offers(a, ctx) {
    const r = await platform.requestOffers({
      tenantId: ctx.tenantId,
      vertical: a.vertical,
      lat: a.lat,
      lng: a.lng,
      query: a.query,
      items: a.items,
      preference: a.preference,
      customerKey: ctx.customerId ?? ctx.sessionId,
    });
    const best = r.offers[0];
    return {
      data: {
        requestId: r.requestId,
        providersAsked: r.providersAsked,
        offers: r.offers.map((o) => ({ offerId: o.id, provider: o.providerName, what: o.headline, price: formatEur(o.priceCents), etaMinutes: o.etaMinutes, distanceM: o.distanceM, special: o.specialTitle, counter: o.round > 1 })),
      },
      ui: ctx.a2ui ? offersUi(r.requestId, r.offers) : undefined,
      say: best
        ? `${r.offers.length} offers from ${r.providersAnswered} of ${r.providersAsked} nearby providers. Best: ${best.providerName}, ${best.headline}, ${formatEur(best.priceCents)}${best.specialTitle ? ` (${best.specialTitle})` : ''}.`
        : 'Nobody nearby has an offer for that right now.',
    };
  },
  async choose_offer(a, ctx) {
    const r: any = await platform.chooseOffer({ offerId: a.offerId, customerId: ctx.customerId, name: a.name, phone: a.phone, addressLine: a.addressLine ?? ctx.location?.addressLine, channel: ctx.channel });
    if (r.vertical === 'retail') {
      return { data: r, ui: ctx.a2ui ? voucherUi({ code: r.code, merchantName: r.providerName, headline: r.headline, priceCents: r.priceCents, expiresAt: r.expiresAt, place: r.place }, r.theme) : undefined, say: `Done: show code ${r.code} at ${r.providerName}.` };
    }
    if (r.vertical === 'fitness') return { data: r, say: r.status === 'confirmed' ? `Booked: ${r.title} at ${r.gymName}.` : `The class is full; you're number ${r.position} on the waitlist.` };
    return { data: r, say: `Ordered from ${r.providerName} for ${formatEur(r.priceCents)}. Order number ${r.orderId}.` };
  },
  async find_nearest_pizzeria(a) {
    const list = await svc.nearest(a.lat, a.lng, a.limit ?? 3);
    return {
      data: list.map((p) => ({ id: p.id, name: p.name, brand: p.brandName, distanceKm: p.distanceKm, etaMinutes: p.etaMinutes })),
      say: list.length ? `Closest: ${list.map((p) => `${p.name} (${p.distanceKm} km, ~${p.etaMinutes} min)`).join('; ')}.` : "We don't deliver there yet.",
    };
  },
  async get_menu(_a, ctx) {
    const { items } = await repo.getMenu();
    return {
      data: items.map((m) => ({ sku: m.sku, name: m.name, price: formatEur(m.basePriceCents), tags: m.tags })),
      ui: ctx.a2ui ? menuUi(items) : undefined,
      say: `Menu: ${items.map((m) => `${m.name} ${formatEur(m.basePriceCents)}`).join(', ')}.`,
    };
  },
  async quote_order(a) {
    const { quote, pizzeria } = await svc.quote(a.lat, a.lng, a.items);
    return {
      data: { pizzeria: pizzeria.name, etaMinutes: pizzeria.etaMinutes, ...quote, total: formatEur(quote.totalCents) },
      say: `${quote.lines.map((l) => `${l.qty}× ${l.name}`).join(', ')} from ${pizzeria.name}: ${formatEur(quote.totalCents)}${quote.campaignCode ? ` (with ${quote.campaignCode})` : ''}, ~${pizzeria.etaMinutes} min.`,
    };
  },
  async place_order(a, ctx) {
    const who = await svc.contactFor(ctx.customerId, a);
    const r = await svc.placeOrder({
      customer: who,
      delivery: { lat: a.lat, lng: a.lng, addressLine: a.addressLine },
      items: a.items,
      channel: (['mcp', 'a2a', 'voice', 'web', 'mobile', 'xr'].includes(ctx.channel) ? ctx.channel : 'agent') as any,
      notifyBy: a.notifyBy,
    });
    return { data: r, say: `Ordered. Your order number is ${r.orderId}.` };
  },
  async order_status(a, ctx) {
    const v = await svc.getOrderView(a.orderId);
    return {
      data: { orderId: v.orderId, status: v.status, pizzeria: v.pizzeriaName, tracking: v.tracking, total: v.quote ? formatEur(v.quote.totalCents) : null },
      ui: ctx.a2ui ? trackerUi(v) : undefined,
      say: `Order ${v.orderId} is ${v.status.replace(/_/g, ' ')}${v.tracking ? `; the courier is ${v.tracking.remainingKm} km away (~${v.tracking.etaMinutes} min)` : ''}.`,
    };
  },
  async cancel_order(a) {
    const r = await svc.cancelOrder(a.orderId, a.reason ?? 'customer_request');
    return { data: r, say: `Order ${a.orderId} is being cancelled and the payment released.` };
  },
  async find_classes(a, ctx) {
    const list = await repo.classesNear(a.lat, a.lng, { kind: a.kind, withinHours: a.withinHours ?? 48 });
    return {
      data: list.map((c) => ({ classId: c.id, title: c.title, gym: c.gymName, startsAt: c.startsAt, spotsLeft: c.spotsLeft, price: formatEur(c.priceCents) })),
      ui: ctx.a2ui ? classesUi(list) : undefined,
      say: list.length ? `Upcoming: ${list.slice(0, 4).map((c) => `${c.title} at ${c.gymName} ${c.startsAt.slice(11, 16)} UTC (${c.spotsLeft} spots)`).join('; ')}.` : 'No classes nearby in that window.',
    };
  },
  async book_class(a, ctx) {
    const r = await platform.bookClass({ classId: a.classId, customerId: ctx.customerId, name: a.name, phone: a.phone });
    return { data: r, say: r.status === 'confirmed' ? `Booked: ${r.title} at ${r.gymName}. Booking ${r.bookingId}.` : `Full: you're number ${r.position} on the waitlist (booking ${r.bookingId}).` };
  },
  async cancel_booking(a) {
    return { data: await platform.cancelBooking(a.bookingId), say: 'Cancelled. If someone was waiting, they get your spot.' };
  },
  async booking_status(a) {
    const b = await platform.bookingStatus(a.bookingId);
    return { data: b, say: `Booking ${a.bookingId} is ${b.status}.` };
  },
  async find_nearby_shops(a) {
    const list = await repo.merchantsNear(a.lat, a.lng, a.radiusM ?? 400, a.category);
    return { data: list.map((m) => ({ id: m.id, name: m.name, category: m.category, place: m.place })), say: list.length ? `Nearby: ${list.map((m) => `${m.name} (${m.category})`).join(', ')}.` : 'No shops found nearby.' };
  },
  async open_support_case(a, ctx) {
    const v = await platform.openSupportCase({ tenantId: ctx.tenantId, customerId: ctx.customerId, orderId: a.orderId, message: a.message, channel: ctx.channel });
    return { data: v, ui: ctx.a2ui ? caseUi(v) : undefined, say: `${v.replies.at(-1) ?? 'We are on it.'} (case ${v.caseId})` };
  },
  async support_case_status(a, ctx) {
    const c: any = await platform.supportCase(a.caseId);
    const live = c.live ?? { caseId: c.id, status: c.status, category: c.category, amountCents: c.creditCents, replies: [c.resolution ?? ''] };
    return { data: c, ui: ctx.a2ui ? caseUi(live) : undefined, say: `Case ${a.caseId} is ${String(live.status).replace(/_/g, ' ')}.` };
  },
};

function tool(name: AgentToolName): ToolSpec {
  const def = toolCatalog[name];
  return {
    name,
    description: def.description,
    parameters: toolJsonSchema(name) as Record<string, unknown>,
    async run(args, ctx) {
      const parsed = def.input.safeParse(args ?? {});
      if (!parsed.success) return { data: { error: 'invalid_arguments', issues: parsed.error.issues }, say: 'Some details were missing.' };
      try {
        return await impls[name](parsed.data, ctx);
      } catch (err) {
        // Business refusals (too late to cancel, offer expired, not signed in) are answers, not crashes.
        if (err instanceof svc.ServiceError) return { data: { error: err.code, message: err.message }, say: err.message };
        throw err;
      }
    },
  };
}

/** UI-only actions (buttons) that are not in the public catalogue. */
const uiActions: ToolSpec[] = [
  {
    name: 'rate_support',
    description: 'Rate a resolved support case 1–5',
    parameters: { type: 'object', properties: { caseId: { type: 'string' }, score: { type: 'number' } } },
    async run(a) {
      await platform.caseCsat(String(a.caseId), Number(a.score));
      return { data: { ok: true }, say: 'Thanks for the rating.' };
    },
  },
];

export function toolsForDomains(domains: ToolDomain[]): ToolSpec[] {
  return (Object.keys(toolCatalog) as AgentToolName[]).filter((n) => domains.includes(toolCatalog[n].domain)).map(tool);
}

export async function executeTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (!(name in toolCatalog)) throw new svc.ServiceError(404, 'unknown_tool', `Unknown tool ${name}`);
  return tool(name as AgentToolName).run((args ?? {}) as Record<string, unknown>, ctx);
}

// ------------------------------------------------------------------ deterministic fallbacks (offline / CI)

const QTY: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };
async function parseCart(text: string) {
  const { items } = await repo.getMenu();
  const lower = text.toLowerCase();
  const out: Array<{ sku: string; qty: number }> = [];
  for (const m of items) {
    for (const n of [m.sku.replace(/-/g, ' '), m.name.toLowerCase().replace(/\s*\(.*\)/, '')]) {
      const i = lower.indexOf(n);
      if (i === -1) continue;
      const before = lower.slice(Math.max(0, i - 12), i).trim().split(/\s+/).pop() ?? '';
      out.push({ sku: m.sku, qty: Number(before) || QTY[before] || 1 });
      break;
    }
  }
  return out;
}
const ok = (r: ToolResult) => ({ reply: r.say ?? 'Done.', ui: r.ui ?? [], toolCalls: [] });
const needLocation = { reply: 'Share your location and I will look around you.', ui: [], toolCalls: [] };

const supportAgent: AgentDef = {
  id: 'support',
  name: 'Support',
  description: 'refunds, credits, late or missing items, booking and voucher problems',
  instructions:
    'You are customer support. Be warm and brief. Open a case for any problem; the platform applies the refund/credit policy and escalates when needed. Never promise amounts yourself.',
  tools: [...toolsForDomains(['support']), ...uiActions],
  fallback: async ({ text, call }) => {
    const caseId = text.match(/case_[a-z0-9]+/i)?.[0];
    if (caseId) return ok(await call('support_case_status', { caseId }));
    if (/refund|late|missing|wrong|cold|burnt|complain|problem|never arrived|hasn't arrived|charged|broken|terrible|still waiting/i.test(text)) {
      const orderId = text.match(/ord_[a-z0-9]+/i)?.[0];
      return ok(await call('open_support_case', { message: text, orderId }));
    }
    return null;
  },
};

const foodAgent: AgentDef = {
  id: 'food',
  name: 'Food ordering',
  description: 'pizza menu, delivery orders, competing offers from nearby kitchens, order tracking',
  instructions:
    'You take food orders. Use request_offers to let nearby kitchens compete when the customer has a cart. Before placing or choosing an offer, read back items and total and get a yes.',
  tools: toolsForDomains(['food', 'offers']),
  fallback: async ({ text, ctx, call }) => {
    const t = text.toLowerCase();
    const orderId = text.match(/ord_[a-z0-9]+/i)?.[0];
    if (orderId && /cancel/.test(t)) return ok(await call('cancel_order', { orderId }));
    if (orderId) return ok(await call('order_status', { orderId }));
    // "Where's my order?" from a signed-in customer (or a callback) needs no order number.
    if (ctx.customerId && /\b(where|status|track|how long|my order|my pizza)\b/.test(t) && !/\b(menu|offers?)\b/.test(t)) {
      const latest = (await repo.getPool().query(`SELECT id FROM orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1`, [ctx.customerId])).rows[0];
      if (latest) return ok(await call('order_status', { orderId: latest.id }));
    }
    if (/\b(menu|vegan|spicy|pizzas?)\b/.test(t) && !/\b(order|want|offers?)\b/.test(t)) {
      const r = await call('get_menu', {});
      const tag = /vegan/.test(t) ? 'vegan' : /spicy/.test(t) ? 'spicy' : null;
      if (!tag) return ok(r);
      const list = (r.data as Array<{ name: string; price: string; tags: string[] }>).filter((m) => m.tags.includes(tag));
      return { reply: `Here's what we have (${tag}): ${list.map((m) => `${m.name} ${m.price}`).join(', ')}.`, ui: r.ui ?? [], toolCalls: [] };
    }
    if (/\b(nearest|closest|near me|which pizzeria)\b/.test(t)) {
      if (!ctx.location) return needLocation;
      return ok(await call('find_nearest_pizzeria', { lat: ctx.location.lat, lng: ctx.location.lng, limit: 3 }));
    }
    const items = await parseCart(text);
    if (items.length) {
      if (!ctx.location) return needLocation;
      if (/\b(offers?|compete|compare|deal|cheapest|fastest)\b/.test(t)) {
        const pref = /cheapest/.test(t) ? 'cheapest' : /fastest/.test(t) ? 'fastest' : 'best_value';
        return ok(await call('request_offers', { vertical: 'food', lat: ctx.location.lat, lng: ctx.location.lng, items, preference: pref }));
      }
      if (/\b(confirm|yes|place it)\b/.test(t)) {
        return ok(await call('place_order', { lat: ctx.location.lat, lng: ctx.location.lng, addressLine: ctx.location.addressLine ?? 'Shared location', items }));
      }
      const q = await call('quote_order', { lat: ctx.location.lat, lng: ctx.location.lng, items });
      return { reply: `${q.say} Say "confirm" to order, or "get offers" to let nearby kitchens compete.`, ui: [], toolCalls: [] };
    }
    return null;
  },
};

const fitnessAgent: AgentDef = {
  id: 'fitness',
  name: 'Fitness booking',
  description: 'gym classes nearby, bookings, waitlists, class offers',
  instructions: 'You book gym classes. Show options with time and spots left; book or waitlist on request.',
  tools: toolsForDomains(['fitness', 'offers']),
  fallback: async ({ text, ctx, call }) => {
    const t = text.toLowerCase();
    const bookingId = text.match(/bk_[a-z0-9]+/i)?.[0];
    if (bookingId && /cancel/.test(t)) return ok(await call('cancel_booking', { bookingId }));
    if (bookingId) return ok(await call('booking_status', { bookingId }));
    const classId = text.match(/cls-[a-z0-9-]+/i)?.[0];
    if (classId && /book|join|reserve/.test(t)) return ok(await call('book_class', { classId }));
    if (/\b(class|classes|yoga|spin|hiit|strength|gym|workout|training)\b/.test(t)) {
      if (!ctx.location) return needLocation;
      const kind = ['yoga', 'spin', 'hiit', 'strength'].find((k) => t.includes(k));
      if (/\b(offers?|deal|cheapest|compare)\b/.test(t)) {
        return ok(await call('request_offers', { vertical: 'fitness', lat: ctx.location.lat, lng: ctx.location.lng, query: kind ?? text }));
      }
      return ok(await call('find_classes', { lat: ctx.location.lat, lng: ctx.location.lng, kind }));
    }
    return null;
  },
};

const retailAgent: AgentDef = {
  id: 'retail',
  name: 'Nearby shopping',
  description: 'shops around the customer (e.g. in a mall) competing with offers for what they want',
  instructions:
    'You help people shop nearby from their GPS position. When they say what they want, call request_offers with vertical "retail" so the shops around them compete. Present the top offers honestly.',
  tools: toolsForDomains(['retail', 'offers']),
  fallback: async ({ text, ctx, call }) => {
    const t = text.toLowerCase();
    if (/\b(shops?|stores?)\b/.test(t) && /\b(what|which|around|nearby|here)\b/.test(t)) {
      if (!ctx.location) return needLocation;
      return ok(await call('find_nearby_shops', { lat: ctx.location.lat, lng: ctx.location.lng }));
    }
    if (/\b(buy|need|looking for|want|offers?|deal|coffee|shoes|sneakers|earbuds|headphones)\b/.test(t)) {
      if (!ctx.location) return needLocation;
      const query = t.replace(/\b(i|want|need|to|buy|a|an|some|looking|for|please|offers?|deals?|get|me|any|on|the|best)\b/g, ' ').replace(/\s+/g, ' ').trim();
      return ok(await call('request_offers', { vertical: 'retail', lat: ctx.location.lat, lng: ctx.location.lng, query: query || t }));
    }
    return null;
  },
};

const specialists: Record<string, AgentDef> = { food: foodAgent, fitness: fitnessAgent, retail: retailAgent };

export async function conciergeFor(tenantId: string): Promise<AgentDef> {
  const tenant = (await repo.getTenant(tenantId)) ?? { id: tenantId, name: 'Assistant', verticals: ['food'], branding: null };
  // Support first (complaints win), then food and fitness (specific words), retail last (broadest).
  const order = ['food', 'fitness', 'retail'];
  const subs = [supportAgent, ...order.filter((v) => tenant.verticals.includes(v)).map((v) => specialists[v]!)];
  const voice = tenant.branding ? `You are the assistant of ${tenant.name}.` : 'You are a neutral local assistant; you do not represent any single brand.';
  return {
    id: `concierge-${tenant.id}`,
    name: tenant.branding ? `${tenant.name} assistant` : 'Nearby assistant',
    description: subs.map((s) => s.description).join('; '),
    instructions: `${voice} Plan multi-step requests with write_todos and delegate to specialists. Use tools for every fact. Be brief. If your previous message proposed a [pending offer <id>] and the customer agrees, call choose_offer with that offerId. On phone calls, speak in short sentences and never read out ids.`,
    tools: [...uiActions, ...toolsForDomains(['offers'])],
    subagents: subs,
    fallback: async (turn) => {
      // A pending offer the agent proposed (e.g. "your usual" on a callback) + a yes → accept it.
      if (/\b(yes|yeah|yep|sure|ok|okay|go ahead|please do|order it|kyllä|joo)\b/i.test(turn.text)) {
        const pending = [...turn.history].reverse().find((h) => h.role === 'assistant' && /\[pending offer (rfq_[A-Za-z0-9]+_\d+)\]/.test(h.content));
        const offerId = pending?.content.match(/\[pending offer (rfq_[A-Za-z0-9]+_\d+)\]/)?.[1];
        if (offerId) {
          const r = await turn.call('choose_offer', { offerId });
          return { reply: r.say ?? 'Done.', ui: r.ui ?? [], toolCalls: [] };
        }
      }
      for (const s of subs) {
        const r = await s.fallback?.(turn);
        if (r) return r;
      }
      await repo.recordProductSignal(turn.ctx.channel, 'unhandled_intent', { theme: 'unrecognised', request: turn.text.slice(0, 200), tenant: tenant.id });
      return {
        reply: `I can help with ${subs.map((s) => s.description.split(',')[0]).join(', ')}. What would you like?`,
        ui: [],
        toolCalls: [],
      };
    },
  };
}

const memory: Memory = {
  load: async (sessionId) => (await repo.loadMessages(sessionId)).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  append: (sessionId, turn, data) => repo.appendMessage(sessionId, turn.role, turn.content, data),
  savePlan: (sessionId, plan) => repo.savePlan(sessionId, plan),
};

export async function runAgentFor(
  tenantId: string,
  input: { sessionId?: string; text?: string; action?: A2uiAction },
  ctx: Omit<ToolContext, 'sessionId' | 'tenantId'>,
) {
  const sessionId = input.sessionId ?? repo.newId('sess');
  await repo.ensureSession(sessionId, tenantId, ctx.channel, ctx.customerId);
  const def = await conciergeFor(tenantId);
  return runDeepAgent(def, { sessionId, text: input.text, action: input.action }, { ...ctx, tenantId, sessionId }, { llm: llmFromEnv(), memory });
}

