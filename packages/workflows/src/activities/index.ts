import * as repo from '@slice/db';
import {
  assignVariant,
  priceCart,
  type CartLine,
  type DeliveryMode,
  type OrderStatus,
  type Quote,
} from '@slice/shared';
import { ApplicationFailure } from '@temporalio/common';
import { CourierCo, OwnFleet, providerFor, type DeliveryProvider } from '../adapters/delivery';
import { GitHubIssues, type IssueTracker } from '../adapters/github';
import { LoggingNotifier, type Channel, type Notifier } from '../adapters/notify';
import { FakePay, type PaymentProvider } from '../adapters/payments';
import { createCallbackActivities, createPlatformActivities } from './platform';

export interface ActivityDeps {
  payments: PaymentProvider;
  delivery: { ownFleet: DeliveryProvider; thirdParty: DeliveryProvider };
  notifier: Notifier;
  issues: IssueTracker;
  now: () => Date;
}

export function defaultDeps(): ActivityDeps {
  return {
    payments: new FakePay(),
    delivery: { ownFleet: new OwnFleet(), thirdParty: new CourierCo() },
    notifier: new LoggingNotifier(),
    issues: new GitHubIssues(),
    now: () => new Date(),
  };
}

export interface RoutedPizzeria {
  id: string;
  name: string;
  brandName: string;
  region: string;
  address: string;
  lat: number;
  lng: number;
  distanceKm: number;
  etaMinutes: number;
  deliveryMode: DeliveryMode;
}

/**
 * Activities = every side effect. Each one is idempotent so Temporal can retry it safely.
 * Factory style lets tests and the worker inject different adapters.
 */
export function createActivities(deps: ActivityDeps = defaultDeps()) {
  return {
    ...createPlatformActivities(deps),
    ...createCallbackActivities(deps),
    // ------------------------------------------------------------ order lifecycle

    /** Nearest open pizzeria with spare capacity, skipping ones already tried. Returns null if none in range. */
    async routeOrder(input: { orderId: string; lat: number; lng: number; exclude: string[]; prefer?: string | null }): Promise<RoutedPizzeria | null> {
      const found = await repo.findNearestPizzerias(
        { lat: input.lat, lng: input.lng },
        { limit: 8, radiusKm: 8, excludeIds: input.exclude },
      );
      // The kitchen whose offer the customer chose goes first; the rest stay nearest-first.
      const candidates = input.prefer ? [...found.filter((c) => c.id === input.prefer), ...found.filter((c) => c.id !== input.prefer)] : found;
      for (const c of candidates) {
        if (c.activeOrders >= c.capacityPer15Min) continue;
        if (await repo.claimPizzeria(input.orderId, c.id)) {
          return {
            id: c.id,
            name: c.name,
            brandName: c.brandName,
            region: c.region,
            address: c.address,
            lat: c.lat,
            lng: c.lng,
            distanceKm: c.distanceKm,
            etaMinutes: c.etaMinutes,
            deliveryMode: c.deliveryMode,
          };
        }
      }
      return null;
    },

    async releasePizzeria(input: { orderId: string; pizzeriaId: string; reason: string }): Promise<void> {
      await repo.setOrderStatus(
        input.orderId,
        'received',
        { type: 'rerouted', payload: { from: input.pizzeriaId, reason: input.reason }, dedupeKey: `reroute:${input.pizzeriaId}` },
        { pizzeriaId: null },
      );
    },

    /** Price is locked here, at first routing. Campaigns + canary experiment are resolved server-side. */
    async priceOrder(input: {
      orderId: string;
      customerId: string;
      pizzeriaId: string;
      region: string;
      distanceKm: number;
      items: CartLine[];
    }): Promise<Quote> {
      const [{ items: menu, overrides }, campaigns, flag] = await Promise.all([
        repo.getMenu(input.pizzeriaId),
        repo.listCampaigns(deps.now()),
        repo.getFlag('fast-delivery-pricing'),
      ]);
      try {
        return priceCart(input.items, menu, {
          now: deps.now(),
          region: input.region,
          distanceKm: input.distanceKm,
          campaigns,
          overrides,
          experimentVariant: assignVariant(flag, input.customerId, input.region),
        });
      } catch (err) {
        throw ApplicationFailure.create({ type: 'InvalidCart', message: (err as Error).message, nonRetryable: true });
      }
    },

    async recordStatus(input: {
      orderId: string;
      status: OrderStatus;
      event: string;
      detail?: Record<string, unknown>;
      quote?: Quote;
      failureReason?: string;
    }): Promise<void> {
      await repo.setOrderStatus(
        input.orderId,
        input.status,
        { type: input.event, payload: input.detail, dedupeKey: `${input.event}:${JSON.stringify(input.detail ?? {})}` },
        { quote: input.quote, failureReason: input.failureReason },
      );
    },

    // ------------------------------------------------------------ payments

    async authorizePayment(input: { orderId: string; amountCents: number }): Promise<{ ref: string }> {
      const { ref } = await deps.payments.authorize(input.orderId, input.amountCents, 'EUR');
      await repo.upsertPayment(input.orderId, deps.payments.name, ref, input.amountCents, 'authorized');
      return { ref };
    },
    async capturePayment(input: { orderId: string; ref: string; amountCents: number }): Promise<void> {
      await deps.payments.capture(input.ref, input.amountCents);
      await repo.upsertPayment(input.orderId, deps.payments.name, input.ref, input.amountCents, 'captured');
    },
    async voidPayment(input: { orderId: string; ref: string; amountCents: number }): Promise<void> {
      await deps.payments.void(input.ref);
      await repo.upsertPayment(input.orderId, deps.payments.name, input.ref, input.amountCents, 'voided');
    },

    // ------------------------------------------------------------ kitchen & delivery

    async notifyPizzeria(input: { orderId: string; pizzeriaId: string; summary: string }): Promise<void> {
      await deps.notifier.send({
        channel: 'push',
        recipient: `pizzeria:${input.pizzeriaId}`,
        message: `New order ${input.orderId}: ${input.summary}`,
        orderId: input.orderId,
        pizzeriaId: input.pizzeriaId,
      });
    },

    async dispatchDelivery(input: {
      orderId: string;
      pizzeria: RoutedPizzeria;
      dropoff: { lat: number; lng: number; addressLine: string };
    }): Promise<{ provider: string; externalRef: string; etaMinutes: number }> {
      const provider = providerFor(input.pizzeria.deliveryMode, deps.delivery);
      const res = await provider.dispatch({
        orderId: input.orderId,
        pizzeriaId: input.pizzeria.id,
        brandName: input.pizzeria.brandName,
        pickup: { lat: input.pizzeria.lat, lng: input.pizzeria.lng, address: input.pizzeria.address },
        dropoff: input.dropoff,
      });
      await repo.upsertDelivery(input.orderId, provider.name, res.externalRef, 'dispatched', res.etaMinutes);
      return { provider: provider.name, ...res };
    },

    async updateDelivery(input: { orderId: string; provider: string; externalRef: string; status: string }): Promise<void> {
      await repo.upsertDelivery(input.orderId, input.provider, input.externalRef, input.status, null);
    },

    async cancelDelivery(input: { orderId: string; provider: string; externalRef: string }): Promise<void> {
      const p = input.provider === deps.delivery.ownFleet.name ? deps.delivery.ownFleet : deps.delivery.thirdParty;
      await p.cancel(input.externalRef);
      await repo.upsertDelivery(input.orderId, input.provider, input.externalRef, 'cancelled', null);
    },

    async notifyCustomer(input: { orderId?: string; customerId: string; channels: Channel[]; message: string; callPurpose?: string }): Promise<void> {
      const channels: Channel[] = input.channels.length ? input.channels : ['push'];
      for (const channel of channels) {
        await deps.notifier.send({
          channel,
          recipient: `customer:${input.customerId}`,
          message: input.message,
          orderId: input.orderId,
          callPurpose: input.callPurpose,
        });
      }
    },

    async consumeInventory(input: { pizzeriaId: string; pizzaCount: number }): Promise<void> {
      await repo.consumeInventoryForOrder(input.pizzeriaId, input.pizzaCount);
    },

    // ------------------------------------------------------------ operations & growth

    async collectKpis(input: { days: number }) {
      const since = new Date(deps.now().getTime() - input.days * 86_400_000);
      return repo.pizzeriaKpis(since);
    },

    async scheduleOpsCall(input: { pizzeriaId: string; region: string; agenda: string[] }): Promise<void> {
      await deps.notifier.send({
        channel: 'ops_call',
        recipient: `ops:${input.region}`,
        pizzeriaId: input.pizzeriaId,
        message: `Weekly call with ${input.pizzeriaId}: ${input.agenda.join('; ')}`,
      });
    },

    async inventoryBelowThreshold() {
      return repo.inventoryBelowThreshold();
    },

    /** Supplier order. Demo: restocks immediately; production: EDI/API to the supplier, restock on delivery. */
    async placeSupplierOrder(input: { pizzeriaId: string; ingredient: string; qty: number; unit: string }): Promise<void> {
      await repo.restock(input.pizzeriaId, input.ingredient, input.qty);
      await deps.notifier.send({
        channel: 'email',
        recipient: `pizzeria:${input.pizzeriaId}`,
        pizzeriaId: input.pizzeriaId,
        message: `Reorder placed: ${input.qty} ${input.unit} ${input.ingredient}`,
      });
    },

    async announceCampaign(input: { code: string; phase: 'start' | 'end' }): Promise<{ audience: number }> {
      const pool = repo.getPool();
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM consents WHERE purpose='marketing' AND granted`,
      );
      const audience = rows[0].n as number;
      await deps.notifier.send({
        channel: 'push',
        recipient: `segment:marketing-consented(${audience})`,
        message: input.phase === 'start' ? `Campaign ${input.code} is live!` : `Campaign ${input.code} has ended.`,
      });
      return { audience };
    },

    async untriagedSignals() {
      return repo.untriagedSignals();
    },

    async openIssue(input: { title: string; body: string; labels: string[] }) {
      return deps.issues.open(input);
    },

    async markSignalsTriaged(input: { ids: number[] }) {
      await repo.markSignalsTriaged(input.ids);
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
