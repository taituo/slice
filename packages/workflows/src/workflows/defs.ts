import { defineQuery, defineSignal } from '@temporalio/workflow';
import type { Duration } from '@temporalio/common';
import type { CartLine, OrderView, Quote } from '@slice/shared';

/** Signals & queries are the order workflow's public API — used by the REST API, kitchen tablets, courier apps and webhooks. */

export interface KitchenEvent {
  action: 'accept' | 'ready' | 'reject';
  reason?: string;
  /** Sending kitchen; events from a kitchen the order was rerouted away from are ignored. */
  pizzeriaId?: string;
}
export interface DeliveryEvent {
  status: 'picked_up' | 'delivered' | 'failed';
  reason?: string;
}

export const statusQuery = defineQuery<OrderView>('status');
export const kitchenSignal = defineSignal<[KitchenEvent]>('kitchen');
export const deliverySignal = defineSignal<[DeliveryEvent]>('delivery');
export const cancelSignal = defineSignal<[{ reason: string }]>('cancel');
/** Courier GPS ping. Updates the live tracking view (position, remaining distance, ETA). */
export const courierLocationSignal = defineSignal<[{ lat: number; lng: number; at?: string }]>('courierLocation');

export interface OrderTimeouts {
  /** How long a kitchen has to accept before the order moves to the next-closest pizzeria. */
  kitchenAccept: Duration;
  /** Max prep time after acceptance. */
  prep: Duration;
  /** Max wait for the courier to pick up after the pizza is ready. */
  pickup: Duration;
  /** Max time from pickup to delivered. */
  delivery: Duration;
}

export const DEFAULT_TIMEOUTS: OrderTimeouts = {
  kitchenAccept: '3 minutes',
  prep: '45 minutes',
  pickup: '30 minutes',
  delivery: '90 minutes',
};

export interface OrderWorkflowInput {
  orderId: string;
  customerId: string;
  region: string;
  channel: string;
  items: CartLine[];
  delivery: { lat: number; lng: number; addressLine: string };
  notifyBy: Array<'sms' | 'call' | 'push' | 'email'>;
  maxRoutingAttempts?: number;
  timeouts?: Partial<OrderTimeouts>;
  /** Set when the customer chose a competing offer: try that kitchen first, at the offered price. */
  offer?: { offerId: string; pizzeriaId: string; quote: Quote } | null;
}
