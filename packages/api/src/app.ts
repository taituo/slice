import { createHmac, timingSafeEqual } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import * as repo from '@slice/db';
import {
  assignVariant,
  campaignUpsertSchema,
  cancelSchema,
  cartLineSchema,
  deliveryEventSchema,
  geoPointSchema,
  kitchenEventSchema,
  menuItemUpsertSchema,
  pizzeriaUpsertSchema,
  placeOrderSchema,
  TERMINAL_STATUSES,
  type A2uiAction,
} from '@slice/shared';
import { callbackStatusQuery, getTemporalClient, OPS_QUEUE, requestCallback } from '@slice/workflows';
import { registerA2a } from './a2a';
import { executeTool, runAgentFor } from './agents';
import { registerAuth, requireCustomer, scopeForTool } from './auth';
import * as platform from './platform';
import * as svc from './services';
import { registerSim } from './sim-routes';
import { adUi } from './ui';
import { registerVoice } from './voice';

const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'dev-admin-key';
const PARTNER_KEY = process.env.PARTNER_API_KEY ?? 'dev-partner-key';
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key';
const WEBHOOK_SECRET = process.env.COURIERCO_WEBHOOK_SECRET ?? 'dev-webhook-secret';
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:4000';
const DEFAULT_TENANT = process.env.DEFAULT_TENANT ?? 'slice';
const OTP_ECHO = process.env.NODE_ENV !== 'production' && process.env.DEV_OTP_ECHO !== 'false';

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Dev-grade keys per role. Production: OIDC (customers), mTLS/API keys per partner, SSO for staff. */
const requireKey = (expected: string, header: string) => async (req: FastifyRequest, reply: FastifyReply) => {
  const got = req.headers[header];
  if (typeof got !== 'string' || !safeEqual(got, expected)) return reply.code(401).send({ error: 'unauthorized' });
};
const admin = { preHandler: requireKey(ADMIN_KEY, 'x-admin-key') };
const partner = { preHandler: requireKey(PARTNER_KEY, 'x-partner-key') };

const tenantOf = (req: FastifyRequest, bodyTenant?: string) =>
  bodyTenant ?? (req.headers['x-tenant'] as string | undefined) ?? (req.query as { tenant?: string })?.tenant ?? DEFAULT_TENANT;

const locationSchema = geoPointSchema.extend({ addressLine: z.string().optional() });

export function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false });
  app.register(cors, { origin: true });
  // Keep the raw body for signed webhooks (ElevenLabs, delivery partners).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });
  registerAuth(app);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof svc.ServiceError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'validation_error', issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? 'internal_error' : 'bad_request', message: (err as Error).message });
  });

  app.get('/health', async () => ({ ok: true, service: 'slice-api', build: process.env.BUILD_ID ?? 'dev' }));
  app.get('/v1/tenants', async () => ({ tenants: await repo.listTenants() }));

  // ------------------------------------------------------------ catalogue (public read, admin write)

  app.get('/v1/brands', async () => ({ brands: await repo.listBrands() }));

  app.get('/v1/pizzerias/nearest', async (req) => {
    const q = geoPointSchema.extend({ limit: z.coerce.number().int().min(1).max(10).default(3) }).parse({
      ...(req.query as object),
      lat: Number((req.query as any).lat),
      lng: Number((req.query as any).lng),
    });
    return { pizzerias: await svc.nearest(q.lat, q.lng, q.limit) };
  });
  app.get('/v1/pizzerias', async (req) => {
    const q = req.query as { region?: string; limit?: string; offset?: string };
    return { pizzerias: await repo.listPizzerias({ region: q.region, limit: Number(q.limit ?? 100), offset: Number(q.offset ?? 0) }) };
  });
  app.get('/v1/pizzerias/:id', async (req, reply) => {
    const p = await repo.getPizzeria((req.params as { id: string }).id);
    return p ?? reply.code(404).send({ error: 'not_found' });
  });
  app.post('/v1/pizzerias', admin, async (req, reply) => {
    const body = pizzeriaUpsertSchema.extend({ id: z.string().regex(/^[a-z0-9-]{3,40}$/) }).parse(req.body);
    if (await repo.getPizzeria(body.id)) return reply.code(409).send({ error: 'exists' });
    return reply.code(201).send(await repo.upsertPizzeria(body.id, body));
  });
  app.put('/v1/pizzerias/:id', admin, async (req) => repo.upsertPizzeria((req.params as { id: string }).id, pizzeriaUpsertSchema.parse(req.body)));
  app.delete('/v1/pizzerias/:id', admin, async (req, reply) => {
    const ok = await repo.closePizzeria((req.params as { id: string }).id);
    return ok ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
  });

  app.get('/v1/menu', async (req) => repo.getMenu((req.query as { pizzeriaId?: string }).pizzeriaId));
  app.put('/v1/menu/:sku', admin, async (req) => {
    const body = menuItemUpsertSchema.parse({ ...(req.body as object), sku: (req.params as { sku: string }).sku });
    await repo.upsertMenuItem(body);
    return body;
  });
  app.delete('/v1/menu/:sku', admin, async (req, reply) => {
    const ok = await repo.deactivateMenuItem((req.params as { sku: string }).sku);
    return ok ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
  });

  app.get('/v1/campaigns', async (req) => {
    const active = (req.query as { active?: string }).active === 'true';
    return { campaigns: await repo.listCampaigns(active ? new Date() : undefined) };
  });
  app.put('/v1/campaigns/:code', admin, async (req) => {
    const body = campaignUpsertSchema.parse({ ...(req.body as object), code: (req.params as { code: string }).code });
    await repo.upsertCampaign(body);
    return body;
  });
  app.delete('/v1/campaigns/:code', admin, async (req, reply) => {
    const ok = await repo.deleteCampaign((req.params as { code: string }).code);
    return ok ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
  });

  // ------------------------------------------------------------ feature flags / canary

  app.get('/v1/flags', admin, async () => ({ flags: await repo.listFlags() }));
  app.put('/v1/flags/:key', admin, async (req) => {
    const body = z.object({ regions: z.array(z.string()).optional(), percent: z.number().min(0).max(100).optional(), build: z.string().optional() }).parse(req.body);
    await repo.setFlag((req.params as { key: string }).key, body);
    return { key: (req.params as { key: string }).key, ...body };
  });
  app.get('/v1/experiments', async (req) => {
    const q = z.object({ subject: z.string().min(1), region: z.string().min(1) }).parse(req.query);
    const flags = await repo.listFlags();
    return { assignments: Object.fromEntries(flags.map((f) => [f.key, assignVariant(f, q.subject, q.region)])) };
  });

  // ------------------------------------------------------------ identity: phone sign-in + connected assistants

  app.post('/v1/auth/otp/start', async (req) => {
    const { phone } = z.object({ phone: z.string().min(5).max(32) }).parse(req.body);
    const code = await repo.startOtp(phone);
    await repo.logNotification({ channel: 'sms', recipient: 'phone:hashed', message: 'Your sign-in code was sent' });
    return { ok: true, ...(OTP_ECHO ? { devCode: code } : {}) };
  });
  app.post('/v1/auth/otp/verify', async (req, reply) => {
    const { phone, code } = z.object({ phone: z.string(), code: z.string().length(6) }).parse(req.body);
    if (!(await repo.verifyOtp(phone, code))) return reply.code(401).send({ error: 'invalid_code' });
    const customerId = await repo.ensureCustomerForPhone(phone);
    const t = await repo.issueToken(customerId, 'session', 'app session', ['browse', 'order', 'track', 'support', 'assistants']);
    return { token: t.token, customerId };
  });
  app.get('/v1/me', { preHandler: requireCustomer() }, async (req) => ({ customerId: req.principal!.customerId, kind: req.principal!.kind, scopes: req.principal!.scopes }));
  app.get('/v1/me/assistants', { preHandler: requireCustomer('assistants') }, async (req) => ({ assistants: await repo.listAssistantTokens(req.principal!.customerId) }));
  app.post('/v1/me/assistants', { preHandler: requireCustomer('assistants') }, async (req, reply) => {
    if (req.principal!.kind !== 'session') return reply.code(403).send({ error: 'forbidden', message: 'Only you can connect assistants.' });
    const body = z
      .object({ label: z.string().min(1).max(60), scopes: z.array(z.enum(['browse', 'order', 'track', 'support'])).min(1).default(['browse', 'order', 'track', 'support']) })
      .parse(req.body);
    const t = await repo.issueToken(req.principal!.customerId, 'assistant', body.label, body.scopes);
    return reply.code(201).send({ id: t.id, token: t.token, scopes: body.scopes, mcpUrl: `${PUBLIC_URL.replace(':4000', ':4100')}/mcp`, a2aUrl: `${PUBLIC_URL}/t/nearby/a2a` });
  });
  app.delete('/v1/me/assistants/:id', { preHandler: requireCustomer('assistants') }, async (req, reply) => {
    const ok = await repo.revokeToken(req.principal!.customerId, (req.params as { id: string }).id);
    return ok ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
  });

  // ------------------------------------------------------------ "call me back": physical & app buttons

  const devTimings = (b: any) =>
    process.env.NODE_ENV !== 'production' && b?.timings
      ? z.object({ debounceMs: z.number().optional(), maxAttempts: z.number().optional(), retryDelayMs: z.number().optional(), answerTimeoutMs: z.number().optional() }).parse(b.timings)
      : undefined;

  app.post('/v1/me/buttons', { preHandler: requireCustomer('assistants') }, async (req, reply) => {
    const b = z
      .object({
        label: z.string().min(1).max(60),
        kind: z.enum(['physical', 'app']).default('physical'),
        tenant: z.string().default(DEFAULT_TENANT),
        quietFrom: z.number().int().min(0).max(23).optional(),
        quietTo: z.number().int().min(0).max(23).optional(),
        timezone: z.string().default('Europe/Berlin'),
      })
      .parse(req.body);
    const r = await repo.registerButton({ customerId: req.principal!.customerId, tenantId: b.tenant, label: b.label, kind: b.kind, quietFrom: b.quietFrom, quietTo: b.quietTo, timezone: b.timezone });
    return reply.code(201).send({ ...r, pressUrl: `${PUBLIC_URL}/v1/buttons/${r.id}/press`, presses: { single: 'call me back', double: 'my usual order', long: 'cancel' } });
  });
  app.get('/v1/me/buttons', { preHandler: requireCustomer() }, async (req) => ({ buttons: await repo.listButtons(req.principal!.customerId) }));
  app.delete('/v1/me/buttons/:id', { preHandler: requireCustomer('assistants') }, async (req, reply) =>
    (await repo.revokeButton(req.principal!.customerId, (req.params as { id: string }).id)) ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' }),
  );

  /** A press from a device. Token in `x-button-token`, a Bearer header, or `?token=` for devices that can only call a URL. */
  const pressHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { token?: string; press?: string };
    const auth = req.headers.authorization?.startsWith('Bearer sk_btn_') ? req.headers.authorization.slice(7) : undefined;
    const token = (req.headers['x-button-token'] as string | undefined) ?? auth ?? q.token;
    const button = token ? await repo.buttonByToken(id, token) : null;
    if (!button) return reply.code(401).send({ error: 'unauthorized' });
    const press = z.enum(['single', 'double', 'long']).parse((req.body as any)?.press ?? q.press ?? 'single');
    const action = button.actions[press];
    const quiet = button.quietFrom != null && button.quietTo != null ? { from: button.quietFrom, to: button.quietTo, timezone: button.timezone } : null;
    const r = await requestCallback({
      customerId: button.customerId,
      tenantId: button.tenantId,
      source: `button:${button.id}`,
      intent: action === 'cancel' ? 'cancel' : action === 'reorder' ? 'reorder' : 'callback',
      quiet,
      timings: devTimings(req.body),
    });
    return reply.code(202).send({ press, action, ...r });
  };
  app.post('/v1/buttons/:id/press', pressHandler);
  // Some buttons (e.g. Shelly) can only fetch a URL: same handler, token and press in the query.
  app.get('/v1/buttons/:id/press', pressHandler);

  app.post('/v1/me/callback', { preHandler: requireCustomer('support') }, async (req, reply) => {
    const b = z.object({ intent: z.enum(['callback', 'reorder', 'cancel']).default('callback'), tenant: z.string().default(DEFAULT_TENANT), reason: z.string().max(200).optional() }).parse(req.body ?? {});
    return reply.code(202).send(await requestCallback({ customerId: req.principal!.customerId, tenantId: b.tenant, source: 'app', intent: b.intent, reason: b.reason, timings: devTimings(req.body) }));
  });

  /** "Call me" on the order tracker: the order id is the capability. */
  app.post('/v1/orders/:id/callback', async (req, reply) => {
    const o = await repo.getOrder((req.params as { id: string }).id);
    if (!o) return reply.code(404).send({ error: 'not_found' });
    return reply.code(202).send(await requestCallback({ customerId: o.customerId, tenantId: DEFAULT_TENANT, source: `order:${o.id}`, intent: 'callback', reason: `order ${o.id}`, timings: devTimings(req.body) }));
  });

  app.get('/v1/callbacks/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = await repo.getCallback(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const live = await (await getTemporalClient()).workflow.getHandle(id).query(callbackStatusQuery).catch(() => null);
    return { ...row, live };
  });

  // ------------------------------------------------------------ ordering (food)

  app.post('/v1/quote', async (req) => {
    const body = z.object({ lat: z.number(), lng: z.number(), items: z.array(cartLineSchema).min(1), customerKey: z.string().optional() }).parse(req.body);
    return svc.quote(body.lat, body.lng, body.items, body.customerKey);
  });
  app.post('/v1/orders', async (req, reply) => {
    const body = placeOrderSchema.parse(req.body);
    const key = req.headers['idempotency-key'];
    const res = await svc.placeOrder(body, { idempotencyKey: typeof key === 'string' ? key : undefined });
    return reply.code(202).send(res);
  });
  app.get('/v1/orders', admin, async (req) => {
    const q = req.query as { status?: string; pizzeriaId?: string; limit?: string };
    return { orders: await repo.listOrders({ status: q.status, pizzeriaId: q.pizzeriaId, limit: Number(q.limit ?? 50) }) };
  });
  app.get('/v1/orders/:id', async (req) => svc.getOrderView((req.params as { id: string }).id));
  app.get('/v1/orders/:id/events', async (req) => ({ events: await repo.listOrderEvents((req.params as { id: string }).id) }));
  app.post('/v1/orders/:id/cancel', async (req) => svc.cancelOrder((req.params as { id: string }).id, cancelSchema.parse(req.body ?? {}).reason));
  app.post('/v1/orders/:id/kitchen', partner, async (req) => svc.kitchenEvent((req.params as { id: string }).id, kitchenEventSchema.parse(req.body)));
  app.post('/v1/orders/:id/delivery', partner, async (req) => svc.deliveryEvent((req.params as { id: string }).id, deliveryEventSchema.parse(req.body)));
  app.post('/v1/orders/:id/location', partner, async (req) => svc.courierLocation((req.params as { id: string }).id, geoPointSchema.parse(req.body)));

  /**
   * Live tracking over Server-Sent Events. The source of truth is the order workflow's status query;
   * the stream pushes a frame whenever it changes (courier pings, kitchen steps) and closes at the end.
   */
  app.get('/v1/orders/:id/stream', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    await svc.getOrderView(id); // 404 early
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
    let last = '';
    let closed = false;
    req.raw.on('close', () => (closed = true));
    const started = Date.now();
    while (!closed && Date.now() - started < 30 * 60_000) {
      const v = await svc.getOrderView(id).catch(() => null);
      if (v) {
        const json = JSON.stringify(v);
        if (json !== last) {
          reply.raw.write(`event: order\ndata: ${json}\n\n`);
          last = json;
        }
        if (TERMINAL_STATUSES.includes(v.status)) break;
      }
      await new Promise((r) => setTimeout(r, Number(process.env.STREAM_POLL_MS ?? 500)));
    }
    reply.raw.end();
    return reply;
  });

  app.post('/v1/webhooks/delivery/courierco', async (req, reply) => {
    const sig = String(req.headers['x-courierco-signature'] ?? '');
    const expected = createHmac('sha256', WEBHOOK_SECRET).update(req.rawBody ?? JSON.stringify(req.body)).digest('hex');
    if (!safeEqual(sig, expected)) return reply.code(401).send({ error: 'bad_signature' });
    const body = z.object({ reference: z.string(), status: z.enum(['picked_up', 'delivered', 'failed']), reason: z.string().optional() }).parse(req.body);
    const d = await repo.getDeliveryByRef('courierco', body.reference);
    if (!d) return reply.code(404).send({ error: 'unknown_reference' });
    return svc.deliveryEvent(d.orderId, { status: body.status, reason: body.reason });
  });

  // ------------------------------------------------------------ competing offers (any vertical)

  app.post('/v1/offers', async (req) => {
    const body = z
      .object({
        tenant: z.string().optional(),
        vertical: z.enum(['food', 'fitness', 'retail']),
        lat: z.number(),
        lng: z.number(),
        query: z.string().max(120).optional(),
        items: z.array(cartLineSchema).optional(),
        preference: z.enum(['best_value', 'cheapest', 'fastest', 'closest']).optional(),
        customerKey: z.string().max(80).optional(),
        windowMs: z.number().int().min(200).max(5000).optional(),
      })
      .parse(req.body);
    return platform.requestOffers({ ...body, tenantId: tenantOf(req, body.tenant), customerKey: req.principal?.customerId ?? body.customerKey ?? 'anonymous' });
  });
  app.post('/v1/offers/:id/accept', async (req) => {
    const body = z
      .object({ name: z.string().optional(), phone: z.string().optional(), addressLine: z.string().optional(), channel: z.string().default('web'), voucherTtlSeconds: z.number().int().min(5).max(7200).optional() })
      .parse(req.body ?? {});
    return platform.chooseOffer({ offerId: (req.params as { id: string }).id, customerId: req.principal?.customerId ?? null, ...body });
  });
  app.get('/v1/vouchers/:code', async (req, reply) => (await repo.getVoucher((req.params as { code: string }).code)) ?? reply.code(404).send({ error: 'not_found' }));
  app.post('/v1/vouchers/:code/redeem', partner, async (req) => {
    const { merchantId } = z.object({ merchantId: z.string() }).parse(req.body);
    return platform.redeemVoucher((req.params as { code: string }).code, merchantId);
  });
  app.get('/v1/shops/nearby', async (req) => {
    const q = z.object({ lat: z.coerce.number(), lng: z.coerce.number(), radiusM: z.coerce.number().default(400) }).parse(req.query);
    return { shops: await repo.merchantsNear(q.lat, q.lng, q.radiusM) };
  });

  // ------------------------------------------------------------ fitness

  app.get('/v1/classes', async (req) => {
    const q = z.object({ lat: z.coerce.number(), lng: z.coerce.number(), kind: z.string().optional(), withinHours: z.coerce.number().default(48) }).parse(req.query);
    return { classes: await repo.classesNear(q.lat, q.lng, q) };
  });
  app.post('/v1/bookings', async (req, reply) => {
    const body = z.object({ classId: z.string(), name: z.string().optional(), phone: z.string().optional(), remindBeforeMin: z.number().optional() }).parse(req.body);
    return reply.code(201).send(await platform.bookClass({ ...body, customerId: req.principal?.customerId ?? null }));
  });
  app.get('/v1/bookings/:id', async (req) => platform.bookingStatus((req.params as { id: string }).id));
  app.post('/v1/bookings/:id/cancel', async (req) => platform.cancelBooking((req.params as { id: string }).id));
  app.post('/v1/bookings/:id/check-in', partner, async (req) => platform.checkIn((req.params as { id: string }).id));

  // ------------------------------------------------------------ support

  app.post('/v1/support/cases', async (req, reply) => {
    const body = z
      .object({
        tenant: z.string().optional(),
        message: z.string().min(3).max(2000),
        orderId: z.string().optional(),
        channel: z.string().default('web'),
        timings: z.object({ approvalSlaMs: z.number().optional(), csatDelayMs: z.number().optional(), csatWaitMs: z.number().optional() }).optional(),
      })
      .parse(req.body);
    return reply.code(201).send(await platform.openSupportCase({ ...body, tenantId: tenantOf(req, body.tenant), customerId: req.principal?.customerId ?? null }));
  });
  app.get('/v1/support/cases/:id', async (req) => platform.supportCase((req.params as { id: string }).id));
  app.post('/v1/support/cases/:id/messages', async (req) => platform.caseMessage((req.params as { id: string }).id, z.object({ body: z.string().min(1) }).parse(req.body).body));
  app.post('/v1/support/cases/:id/csat', async (req) => platform.caseCsat((req.params as { id: string }).id, z.object({ score: z.number().min(1).max(5) }).parse(req.body).score));
  app.post('/v1/support/cases/:id/decision', admin, async (req) =>
    platform.caseDecision((req.params as { id: string }).id, z.object({ approve: z.boolean(), amountCents: z.number().int().optional(), note: z.string().optional() }).parse(req.body)),
  );

  // ------------------------------------------------------------ ads

  app.get('/v1/ads', async (req) => {
    const q = z.object({ tenant: z.string().optional(), lat: z.coerce.number().optional(), lng: z.coerce.number().optional() }).parse(req.query);
    const ad = await platform.serveAd(tenantOf(req, q.tenant), q.lat, q.lng);
    return ad ? { ad: { id: ad.id, headline: ad.headline, body: ad.body, cta: ad.cta, theme: ad.theme, providerId: ad.providerId, sourceKey: ad.sourceKey }, ui: adUi(ad) } : { ad: null, ui: [] };
  });
  app.post('/v1/ads/:id/click', async (req) => platform.clickAd((req.params as { id: string }).id));
  app.get('/v1/admin/ads', admin, async () => ({ ads: await repo.listAds() }));
  app.post('/v1/admin/ads/run', admin, async () =>
    (await getTemporalClient()).workflow.execute('adOptimizerWorkflow', { taskQueue: OPS_QUEUE, workflowId: `ads-${Date.now()}`, args: [{}] }),
  );

  // ------------------------------------------------------------ GDPR

  app.get('/v1/customers/:id/export', admin, async (req, reply) => (await repo.exportCustomer((req.params as { id: string }).id)) ?? reply.code(404).send({ error: 'not_found' }));
  app.delete('/v1/customers/:id', admin, async (req, reply) => {
    const ok = await repo.eraseCustomer((req.params as { id: string }).id, 'admin-api');
    return ok ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
  });

  // ------------------------------------------------------------ agents, tools & product signals

  const chatSchema = z.object({
    tenant: z.string().optional(),
    sessionId: z.string().max(120).optional(),
    message: z.string().max(4000).optional(),
    messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) })).max(40).optional(),
    action: z.object({ name: z.string(), surfaceId: z.string(), sourceComponentId: z.string(), timestamp: z.string(), context: z.record(z.string(), z.unknown()) }).optional(),
    context: z
      .object({
        location: locationSchema.optional(),
        customer: z.object({ name: z.string(), phone: z.string() }).optional(),
        source: z.enum(['web', 'mobile', 'xr', 'voice', 'sim']).optional(),
        a2ui: z.boolean().optional(),
      })
      .optional(),
  });
  app.post('/v1/agent/chat', async (req) => {
    const b = chatSchema.parse(req.body);
    const text = b.message ?? [...(b.messages ?? [])].reverse().find((m) => m.role === 'user')?.content;
    let customerId = req.principal?.customerId ?? null;
    if (!customerId && b.context?.customer) customerId = await repo.upsertCustomer({ ...b.context.customer, region: 'de-berlin' });
    return runAgentFor(tenantOf(req, b.tenant), { sessionId: b.sessionId, text, action: b.action as A2uiAction | undefined }, {
      channel: b.context?.source ?? 'web',
      customerId,
      location: b.context?.location,
      a2ui: b.context?.a2ui ?? true,
    });
  });

  /** One endpoint per catalogue tool: used by the MCP server, partner integrations and tests. */
  app.post('/v1/tools/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (req.principal?.kind === 'assistant' && !req.principal.scopes.includes(scopeForTool(name))) {
      return reply.code(403).send({ error: 'forbidden', message: `Assistant token lacks the "${scopeForTool(name)}" scope` });
    }
    const body = z.object({ tenant: z.string().optional(), args: z.record(z.string(), z.unknown()).default({}), sessionId: z.string().optional(), location: locationSchema.optional() }).parse(req.body ?? {});
    const r = await executeTool(name, body.args, {
      tenantId: tenantOf(req, body.tenant),
      sessionId: body.sessionId ?? `tool-${Date.now()}`,
      channel: (req.headers['x-channel'] as string) ?? 'mcp',
      customerId: req.principal?.customerId ?? null,
      location: body.location,
      a2ui: false,
    });
    return { data: r.data, say: r.say ?? null };
  });

  app.post('/v1/internal/agent-turn', { preHandler: requireKey(INTERNAL_KEY, 'x-internal-key') }, async (req) => {
    const b = z.object({ tenantId: z.string(), sessionId: z.string(), text: z.string(), customerToken: z.string().nullable().optional() }).parse(req.body);
    const tok = b.customerToken?.startsWith('sk_') ? await repo.resolveToken(b.customerToken) : null;
    return runAgentFor(b.tenantId, { sessionId: b.sessionId, text: b.text }, { channel: 'a2a', customerId: tok?.customerId ?? null, a2ui: true });
  });

  app.post('/v1/signals', async (req) => {
    const body = z.object({ kind: z.string().max(40), source: z.string().max(20).default('web'), detail: z.record(z.string(), z.unknown()) }).parse(req.body);
    await repo.recordProductSignal(body.source, body.kind, body.detail);
    return { ok: true };
  });

  registerA2a(app, PUBLIC_URL);
  registerVoice(app);
  registerSim(app, ADMIN_KEY);
  return app;
}
