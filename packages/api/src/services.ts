import { createHash } from 'node:crypto';
import * as repo from '@slice/db';
import {
  assignVariant,
  priceCart,
  TERMINAL_STATUSES,
  type CartLine,
  type OrderView,
  type PlaceOrderInput,
  type Quote,
} from '@slice/shared';
import {
  cancelSignal,
  courierLocationSignal,
  deliverySignal,
  getTemporalClient,
  kitchenSignal,
  ordersQueueFor,
  statusQuery,
  type DeliveryEvent,
  type KitchenEvent,
  type OrderWorkflowInput,
} from '@slice/workflows';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';

/**
 * Application services: the one place business entry points live. REST routes, the in-app agent,
 * A2A and (via REST) MCP all call these, so every channel gets identical behaviour.
 */

export class ServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const DELIVERY_RADIUS_KM = Number(process.env.DELIVERY_RADIUS_KM ?? 8);

export async function nearest(lat: number, lng: number, limit = 3) {
  return repo.findNearestPizzerias({ lat, lng }, { limit, radiusKm: DELIVERY_RADIUS_KM });
}

export async function quote(lat: number, lng: number, items: CartLine[], customerKey = 'anonymous') {
  const [p] = await nearest(lat, lng, 1);
  if (!p) throw new ServiceError(422, 'outside_delivery_area', 'No open pizzeria delivers to this location yet.');
  const [{ items: menu, overrides }, campaigns, flag] = await Promise.all([
    repo.getMenu(p.id),
    repo.listCampaigns(new Date()),
    repo.getFlag('fast-delivery-pricing'),
  ]);
  try {
    const q = priceCart(items, menu, {
      now: new Date(),
      region: p.region,
      distanceKm: p.distanceKm,
      campaigns,
      overrides,
      experimentVariant: assignVariant(flag, customerKey, p.region),
    });
    return { quote: q, pizzeria: p };
  } catch (err) {
    throw new ServiceError(422, 'invalid_cart', (err as Error).message);
  }
}

/** Idempotency-Key → stable order id → Temporal rejects duplicate starts → safe client retries. */
function orderIdFor(idempotencyKey?: string): string {
  if (!idempotencyKey) return repo.newOrderId();
  return `ord_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 20)}`;
}

export async function placeOrder(input: PlaceOrderInput, opts: { idempotencyKey?: string; timeouts?: OrderWorkflowInput['timeouts'] } = {}) {
  // A chosen competing offer pins the kitchen and the price.
  let offer: OrderWorkflowInput['offer'] = null;
  if (input.offerId) {
    const o = await repo.getOffer(input.offerId);
    if (!o || o.vertical !== 'food' || o.status !== 'won') throw new ServiceError(409, 'offer_unavailable', 'That offer is no longer available');
    const d = o.details as { pizzeriaId: string; quote: Quote };
    offer = { offerId: o.id, pizzeriaId: d.pizzeriaId, quote: d.quote };
  }
  // Region = region of the nearest kitchen (open or not); outside every radius → not served yet.
  const [anyNearby] = await repo.findNearestPizzerias(input.delivery, { limit: 1, radiusKm: DELIVERY_RADIUS_KM, onlyOpen: false });
  if (!anyNearby) throw new ServiceError(422, 'outside_delivery_area', 'No pizzeria delivers to this location yet.');

  // Validate the cart up front so obvious mistakes fail fast (the workflow re-prices authoritatively).
  const { items: menu } = await repo.getMenu();
  const known = new Set(menu.map((m) => m.sku));
  const unknown = input.items.filter((i) => !known.has(i.sku)).map((i) => i.sku);
  if (unknown.length) throw new ServiceError(422, 'invalid_cart', `Unknown items: ${unknown.join(', ')}`);

  const customerId = await repo.upsertCustomer({
    name: input.customer.name,
    phone: input.customer.phone,
    email: input.customer.email,
    region: anyNearby.region,
    marketingConsent: input.customer.marketingConsent,
    address: { line: input.delivery.addressLine, lat: input.delivery.lat, lng: input.delivery.lng },
  });

  const orderId = orderIdFor(opts.idempotencyKey);
  await repo.createOrder({
    id: orderId,
    customerId,
    region: anyNearby.region,
    channel: input.channel,
    items: input.items,
    deliveryLat: input.delivery.lat,
    deliveryLng: input.delivery.lng,
  });

  if (input.offerId || input.adId) {
    await repo.getPool().query(`UPDATE orders SET offer_id=$2, ad_id=$3 WHERE id=$1`, [orderId, input.offerId ?? null, input.adId ?? null]);
  }
  if (input.adId) await repo.countAdEvent(input.adId, 'conversions');

  const wfInput: OrderWorkflowInput = {
    orderId,
    customerId,
    region: anyNearby.region,
    channel: input.channel,
    items: input.items,
    delivery: input.delivery,
    notifyBy: input.notifyBy ?? ['push'],
    timeouts: opts.timeouts,
    offer,
  };
  const client = await getTemporalClient();
  try {
    await client.workflow.start('orderWorkflow', {
      workflowId: orderId,
      taskQueue: ordersQueueFor(anyNearby.region),
      args: [wfInput],
      memo: { region: anyNearby.region, channel: input.channel },
    });
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
  }
  return { orderId, status: 'received', trackingUrl: `/track/${orderId}` };
}

export async function getOrderView(orderId: string): Promise<OrderView> {
  const client = await getTemporalClient();
  try {
    const handle = client.workflow.getHandle(orderId);
    const desc = await handle.describe();
    if (desc.status.name === 'RUNNING') return await handle.query(statusQuery);
    if (desc.status.name === 'COMPLETED') return (await handle.result()) as OrderView;
  } catch (err) {
    if (!(err instanceof WorkflowNotFoundError)) throw err;
  }
  // Archived/retention-expired workflows: rebuild the view from the business record.
  const row = await repo.getOrder(orderId);
  if (!row) throw new ServiceError(404, 'not_found', 'Order not found');
  const p = row.pizzeriaId ? await repo.getPizzeria(row.pizzeriaId) : null;
  return {
    orderId,
    status: row.status,
    pizzeriaId: row.pizzeriaId,
    pizzeriaName: p?.name ?? null,
    brandName: p?.brandName ?? null,
    attemptedPizzerias: row.pizzeriaId ? [row.pizzeriaId] : [],
    quote: row.quote,
    delivery: null,
    tracking: null,
    offerId: null,
    timeline: await repo.listOrderEvents(orderId),
    failureReason: row.failureReason,
  };
}

async function runningHandle(orderId: string) {
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(orderId);
  try {
    const desc = await handle.describe();
    if (desc.status.name !== 'RUNNING') throw new ServiceError(409, 'order_closed', 'Order is already completed');
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) throw new ServiceError(404, 'not_found', 'Order not found');
    throw err;
  }
  return handle;
}

export async function cancelOrder(orderId: string, reason: string) {
  const handle = await runningHandle(orderId);
  const view = await handle.query(statusQuery);
  if (['out_for_delivery', ...TERMINAL_STATUSES].includes(view.status)) {
    throw new ServiceError(409, 'not_cancellable', `Order is ${view.status} and can no longer be cancelled`);
  }
  await handle.signal(cancelSignal, { reason });
  return { ok: true };
}

export async function kitchenEvent(orderId: string, e: KitchenEvent) {
  const handle = await runningHandle(orderId);
  await handle.signal(kitchenSignal, e);
  return { ok: true };
}

export async function deliveryEvent(orderId: string, e: DeliveryEvent) {
  const handle = await runningHandle(orderId);
  await handle.signal(deliverySignal, e);
  return { ok: true };
}

export async function courierLocation(orderId: string, p: { lat: number; lng: number }) {
  const handle = await runningHandle(orderId);
  await handle.signal(courierLocationSignal, { ...p, at: new Date().toISOString() });
  return { ok: true };
}

/** Fill in name/phone for a signed-in customer so agents never have to ask for them. */
export async function contactFor(customerId: string | null, given: { name?: string; phone?: string }) {
  if (given.name && given.phone) return { name: given.name, phone: given.phone };
  if (customerId) {
    const c = await repo.getCustomerContact(customerId);
    if (c?.phone) return { name: given.name ?? (c.name || 'Customer'), phone: c.phone };
  }
  throw new ServiceError(401, 'identify', 'Sign in, or give a name and phone number.');
}
