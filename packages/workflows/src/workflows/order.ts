import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  condition,
  log,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { OrderStatus, OrderView, Quote } from '@slice/shared';
import type { Activities, RoutedPizzeria } from '../activities';
import { haversineKm } from '@slice/shared/src/geo';
import {
  cancelSignal,
  courierLocationSignal,
  DEFAULT_TIMEOUTS,
  deliverySignal,
  kitchenSignal,
  statusQuery,
  type DeliveryEvent,
  type KitchenEvent,
  type OrderWorkflowInput,
} from './defs';

const acts = proxyActivities<Activities>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '1 second', maximumInterval: '30 seconds', maximumAttempts: 8 },
});

/** Statuses after which a customer can no longer cancel (the pizza is on a bike). */
const NON_CANCELLABLE: OrderStatus[] = ['out_for_delivery', 'delivered', 'cancelled', 'failed'];

class OrderStopped extends Error {
  constructor(
    readonly finalStatus: 'cancelled' | 'failed',
    readonly reason: string,
  ) {
    super(reason);
  }
}

/**
 * One workflow per order — the long-running "order chain".
 *
 *   received → routed (nearest kitchen with capacity) → payment_authorized → accepted → preparing
 *            → ready → out_for_delivery → delivered
 *
 * Kitchen doesn't accept in time / rejects → release and route to the next-closest pizzeria.
 * Anything fails or the customer cancels before pickup → compensations run in reverse
 * (cancel courier, void payment) and the order ends cancelled/failed.
 */
export async function orderWorkflow(input: OrderWorkflowInput): Promise<OrderView> {
  const t = { ...DEFAULT_TIMEOUTS, ...input.timeouts };
  const maxAttempts = input.maxRoutingAttempts ?? 3;

  const view: OrderView = {
    orderId: input.orderId,
    status: 'received',
    pizzeriaId: null,
    pizzeriaName: null,
    brandName: null,
    attemptedPizzerias: [],
    quote: null,
    delivery: null,
    tracking: null,
    offerId: input.offer?.offerId ?? null,
    timeline: [{ type: 'received', at: new Date().toISOString(), detail: { channel: input.channel } }],
    failureReason: null,
  };

  let kitchen: KitchenEvent | null = null;
  let kitchenReady = false;
  let courier: DeliveryEvent | null = null;
  let cancelRequest: { reason: string } | null = null;

  setHandler(statusQuery, () => view);
  setHandler(kitchenSignal, (e) => {
    // A tablet at a pizzeria we already rerouted away from must not affect the order.
    if (e.pizzeriaId && e.pizzeriaId !== view.pizzeriaId) return;
    if (e.action === 'ready') kitchenReady = true;
    else kitchen = e;
  });
  setHandler(deliverySignal, (e) => {
    // Keep the most significant status: delivered/failed beat picked_up.
    if (!courier || e.status !== 'picked_up') courier = e;
  });
  setHandler(courierLocationSignal, (p) => {
    if (!pizzeria || !['ready', 'out_for_delivery'].includes(view.status)) return;
    const total = Math.max(0.05, haversineKm(pizzeria, input.delivery));
    const remaining = haversineKm(p, input.delivery);
    view.tracking = {
      lat: p.lat,
      lng: p.lng,
      at: p.at ?? new Date().toISOString(),
      remainingKm: Math.round(remaining * 100) / 100,
      etaMinutes: Math.max(1, Math.ceil((remaining / 18) * 60)),
      progress: Math.round(Math.min(1, Math.max(0, 1 - remaining / total)) * 100) / 100,
    };
  });
  setHandler(cancelSignal, (e) => {
    if (NON_CANCELLABLE.includes(view.status)) {
      view.timeline.push({ type: 'cancel_rejected', at: new Date().toISOString(), detail: { status: view.status } });
      return;
    }
    cancelRequest = e;
  });

  const setStatus = async (status: OrderStatus, event: string, detail?: Record<string, unknown>, quote?: Quote) => {
    view.status = status;
    view.timeline.push({ type: event, at: new Date().toISOString(), detail });
    await acts.recordStatus({ orderId: input.orderId, status, event, detail, quote });
  };
  const checkCancelled = () => {
    if (cancelRequest) throw new OrderStopped('cancelled', cancelRequest.reason);
  };

  const compensations: Array<() => Promise<void>> = [];
  let payment: { ref: string; amountCents: number } | null = null;
  let pizzeria: RoutedPizzeria | null = null;

  try {
    // ---------------------------------------------------------------- 1. route + lock price + authorize
    let accepted = false;
    for (let attempt = 1; attempt <= maxAttempts && !accepted; attempt++) {
      checkCancelled();
      pizzeria = await acts.routeOrder({
        orderId: input.orderId,
        lat: input.delivery.lat,
        lng: input.delivery.lng,
        exclude: view.attemptedPizzerias,
        prefer: attempt === 1 ? (input.offer?.pizzeriaId ?? null) : null,
      });
      if (!pizzeria) throw new OrderStopped('failed', 'no_pizzeria_available');
      kitchen = null;

      view.attemptedPizzerias.push(pizzeria.id);
      view.pizzeriaId = pizzeria.id;
      view.pizzeriaName = pizzeria.name;
      view.brandName = pizzeria.brandName;
      await setStatus('routed', 'routed', {
        pizzeriaId: pizzeria.id,
        distanceKm: pizzeria.distanceKm,
        attempt,
      });

      if (!payment) {
        // A chosen offer already fixed the price; otherwise price now, once.
        const quote = input.offer?.quote ?? await acts.priceOrder({
          orderId: input.orderId,
          customerId: input.customerId,
          pizzeriaId: pizzeria.id,
          region: pizzeria.region,
          distanceKm: pizzeria.distanceKm,
          items: input.items,
        });
        view.quote = quote;
        const auth = await acts.authorizePayment({ orderId: input.orderId, amountCents: quote.totalCents });
        payment = { ref: auth.ref, amountCents: quote.totalCents };
        const p = payment;
        compensations.push(() => acts.voidPayment({ orderId: input.orderId, ...p }));
        await setStatus('payment_authorized', 'payment_authorized', { totalCents: quote.totalCents }, quote);
      }

      const summary = input.items.map((i) => `${i.qty}× ${i.sku}`).join(', ');
      await acts.notifyPizzeria({ orderId: input.orderId, pizzeriaId: pizzeria.id, summary });

      // ---------------------------------------------------------------- 2. wait for the kitchen
      const answered = await condition(() => kitchen !== null || cancelRequest !== null, t.kitchenAccept);
      checkCancelled();
      const k = kitchen as KitchenEvent | null;
      if (answered && k?.action === 'accept') {
        accepted = true;
        await setStatus('accepted', 'accepted', { pizzeriaId: pizzeria.id });
      } else {
        const reason = k?.action === 'reject' ? `rejected: ${k.reason ?? 'busy'}` : 'accept_timeout';
        log.info('Rerouting order', { orderId: input.orderId, from: pizzeria.id, reason });
        view.timeline.push({ type: 'rerouted', at: new Date().toISOString(), detail: { from: pizzeria.id, reason } });
        await acts.releasePizzeria({ orderId: input.orderId, pizzeriaId: pizzeria.id, reason });
        view.status = 'received';
        pizzeria = null;
      }
    }
    if (!accepted || !pizzeria) throw new OrderStopped('failed', 'no_kitchen_accepted');
    const kitchenPizzeria: RoutedPizzeria = pizzeria;

    await acts.notifyCustomer({
      orderId: input.orderId,
      customerId: input.customerId,
      channels: input.notifyBy,
      message: `${kitchenPizzeria.brandName} is making your order (ETA ~${kitchenPizzeria.etaMinutes} min).`,
    });

    // ---------------------------------------------------------------- 3. prepare
    await setStatus('preparing', 'preparing');
    if (!(await condition(() => kitchenReady || cancelRequest !== null, t.prep))) {
      throw new OrderStopped('failed', 'kitchen_timeout');
    }
    checkCancelled();
    await setStatus('ready', 'ready');

    // ---------------------------------------------------------------- 4. dispatch & deliver
    const dispatch = await acts.dispatchDelivery({ orderId: input.orderId, pizzeria: kitchenPizzeria, dropoff: input.delivery });
    view.delivery = { provider: dispatch.provider, externalRef: dispatch.externalRef, etaMinutes: dispatch.etaMinutes };
    compensations.push(() => acts.cancelDelivery({ orderId: input.orderId, ...dispatch }));
    view.timeline.push({ type: 'courier_dispatched', at: new Date().toISOString(), detail: { ...dispatch } });

    const pickedUp = await condition(() => courier !== null || cancelRequest !== null, t.pickup);
    checkCancelled();
    if (!pickedUp) throw new OrderStopped('failed', 'pickup_timeout');
    if ((courier as DeliveryEvent | null)?.status === 'failed') throw new OrderStopped('failed', 'courier_failed');

    await setStatus('out_for_delivery', 'picked_up', { provider: dispatch.provider });
    await acts.updateDelivery({ orderId: input.orderId, provider: dispatch.provider, externalRef: dispatch.externalRef, status: 'picked_up' });
    await acts.notifyCustomer({
      orderId: input.orderId,
      customerId: input.customerId,
      channels: input.notifyBy,
      message: `Your ${kitchenPizzeria.brandName} order is on its way!`,
    });

    const done = await condition(
      () => (courier as DeliveryEvent | null)?.status === 'delivered' || (courier as DeliveryEvent | null)?.status === 'failed',
      t.delivery,
    );
    if (!done || (courier as DeliveryEvent | null)?.status === 'failed') {
      throw new OrderStopped('failed', (courier as DeliveryEvent | null)?.reason ?? 'delivery_failed');
    }

    // ---------------------------------------------------------------- 5. settle
    await acts.capturePayment({ orderId: input.orderId, ref: payment!.ref, amountCents: payment!.amountCents });
    compensations.length = 0; // captured: nothing left to roll back
    await acts.updateDelivery({ orderId: input.orderId, provider: dispatch.provider, externalRef: dispatch.externalRef, status: 'delivered' });
    await setStatus('delivered', 'delivered');
    await acts.notifyCustomer({
      orderId: input.orderId,
      customerId: input.customerId,
      channels: input.notifyBy,
      message: 'Delivered. Buon appetito! 🍕',
    });
    const pizzaCount = input.items.reduce((n, i) => n + i.qty, 0);
    await acts.consumeInventory({ pizzeriaId: kitchenPizzeria.id, pizzaCount });
    return view;
  } catch (err) {
    const stopped =
      err instanceof OrderStopped
        ? err
        : new OrderStopped('failed', failureType(err));
    // Compensate even if the workflow itself is being cancelled.
    await CancellationScope.nonCancellable(async () => {
      for (const undo of compensations.reverse()) {
        try {
          await undo();
        } catch (e) {
          log.error('Compensation failed', { orderId: input.orderId, error: String(e) });
        }
      }
      view.failureReason = stopped.reason;
      view.status = stopped.finalStatus;
      view.timeline.push({ type: stopped.finalStatus, at: new Date().toISOString(), detail: { reason: stopped.reason } });
      await acts.recordStatus({
        orderId: input.orderId,
        status: stopped.finalStatus,
        event: stopped.finalStatus,
        detail: { reason: stopped.reason },
        failureReason: stopped.reason,
      });
      await acts.notifyCustomer({
        orderId: input.orderId,
        customerId: input.customerId,
        channels: input.notifyBy,
        message:
          stopped.finalStatus === 'cancelled'
            ? 'Your order was cancelled and the payment released.'
            : `Sorry — we couldn't complete your order (${stopped.reason}). You have not been charged.`,
      });
    });
    return view;
  }
}

function failureType(err: unknown): string {
  const cause = err instanceof ActivityFailure ? err.cause : err;
  if (cause instanceof ApplicationFailure) return cause.type ?? cause.message;
  return 'internal_error';
}
