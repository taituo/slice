import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { resolve } from 'node:path';
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import type { OrderView } from '@slice/shared';
import type { Activities, RoutedPizzeria } from '../src/activities';
import { cancelSignal, deliverySignal, kitchenSignal, statusQuery, type OrderWorkflowInput } from '../src/workflows/defs';

/**
 * Workflow logic tested in isolation: real Temporal server, fake activities (no Postgres needed).
 * Set TEMPORAL_CLI_PATH to reuse a local `temporal` binary instead of downloading one.
 */
let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger('WARN') });
  env = await TestWorkflowEnvironment.createLocal(
    process.env.TEMPORAL_CLI_PATH ? { server: { executable: { type: 'existing-path', path: process.env.TEMPORAL_CLI_PATH } } } : {},
  );
  workflowBundle = await bundleWorkflowCode({ workflowsPath: resolve(__dirname, '../src/workflows/index.ts') });
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const kitchens: RoutedPizzeria[] = ['k1', 'k2', 'k3'].map((id, i) => ({
  id,
  name: `Kitchen ${id}`,
  brandName: 'Slice Network',
  region: 'de-berlin-mitte',
  address: `${id} street`,
  lat: 52.52,
  lng: 13.4 + i / 100,
  distanceKm: 1 + i,
  etaMinutes: 20 + i,
  deliveryMode: 'own_fleet',
}));

function fakeActivities(opts: { declinePayment?: boolean } = {}) {
  const calls: string[] = [];
  const log = (s: string) => calls.push(s);
  const acts: Partial<Activities> = {
    async routeOrder({ exclude }) {
      const k = kitchens.find((x) => !exclude.includes(x.id)) ?? null;
      log(`route:${k?.id ?? 'none'}`);
      return k;
    },
    async releasePizzeria({ pizzeriaId }) {
      log(`release:${pizzeriaId}`);
    },
    async priceOrder() {
      log('price');
      return { lines: [], subtotalCents: 2000, discountCents: 0, deliveryFeeCents: 290, totalCents: 2290, currency: 'EUR', campaignCode: null, experimentVariant: 'control' };
    },
    async recordStatus({ status }) {
      log(`status:${status}`);
    },
    async authorizePayment({ orderId }) {
      if (opts.declinePayment) throw ApplicationFailure.create({ type: 'PaymentDeclined', nonRetryable: true });
      log('authorize');
      return { ref: `fp_${orderId}` };
    },
    async capturePayment() {
      log('capture');
    },
    async voidPayment() {
      log('void');
    },
    async notifyPizzeria({ pizzeriaId }) {
      log(`notify:${pizzeriaId}`);
    },
    async dispatchDelivery() {
      log('dispatch');
      return { provider: 'own_fleet', externalRef: 'fleet_1', etaMinutes: 12 };
    },
    async updateDelivery() {},
    async cancelDelivery() {
      log('cancel_delivery');
    },
    async notifyCustomer() {},
    async consumeInventory() {
      log('inventory');
    },
  };
  return { acts, calls };
}

async function withWorker<T>(acts: Partial<Activities>, fn: (taskQueue: string) => Promise<T>): Promise<T> {
  const taskQueue = `test-${Math.random().toString(36).slice(2)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle,
    activities: acts,
  });
  return worker.runUntil(fn(taskQueue));
}

const input = (orderId: string, timeouts: OrderWorkflowInput['timeouts'] = {}): OrderWorkflowInput => ({
  orderId,
  customerId: 'c1',
  region: 'de-berlin-mitte',
  channel: 'web',
  items: [{ sku: 'margherita', qty: 2 }],
  delivery: { lat: 52.53, lng: 13.4, addressLine: 'Test 1' },
  notifyBy: ['sms'],
  timeouts: { kitchenAccept: '1 second', ...timeouts },
});

async function until(handle: { query: (q: typeof statusQuery) => Promise<OrderView> }, pred: (v: OrderView) => boolean) {
  for (let i = 0; i < 100; i++) {
    const v = await handle.query(statusQuery);
    if (pred(v)) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not reached');
}

describe('orderWorkflow', () => {
  it('happy path: routes, authorizes, cooks, delivers, captures', async () => {
    const { acts, calls } = fakeActivities();
    const view = await withWorker(acts, async (taskQueue) => {
      const h = await env.client.workflow.start('orderWorkflow', { taskQueue, workflowId: 'o-happy', args: [input('o-happy')] });
      await until(h, (v) => v.status === 'payment_authorized');
      await h.signal(kitchenSignal, { action: 'accept', pizzeriaId: 'k1' });
      await until(h, (v) => v.status === 'preparing');
      await h.signal(kitchenSignal, { action: 'ready' });
      await until(h, (v) => v.delivery !== null);
      await h.signal(deliverySignal, { status: 'picked_up' });
      await until(h, (v) => v.status === 'out_for_delivery');
      await h.signal(deliverySignal, { status: 'delivered' });
      return (await h.result()) as OrderView;
    });
    expect(view.status).toBe('delivered');
    expect(view.pizzeriaId).toBe('k1');
    expect(calls).toContain('capture');
    expect(calls).not.toContain('void');
  }, 30_000);

  it('reroutes to the next-closest kitchen when the first does not accept in time', async () => {
    const { acts, calls } = fakeActivities();
    const view = await withWorker(acts, async (taskQueue) => {
      const h = await env.client.workflow.start('orderWorkflow', { taskQueue, workflowId: 'o-reroute', args: [input('o-reroute')] });
      // k1 ignores the order (timeout), k2 rejects, k3 accepts.
      await until(h, (v) => v.pizzeriaId === 'k2' && v.status === 'routed');
      await h.signal(kitchenSignal, { action: 'reject', reason: 'busy', pizzeriaId: 'k2' });
      await until(h, (v) => v.pizzeriaId === 'k3' && v.status === 'routed');
      await h.signal(kitchenSignal, { action: 'accept', pizzeriaId: 'k3' });
      await until(h, (v) => v.status === 'preparing');
      await h.signal(cancelSignal, { reason: 'test over' });
      return (await h.result()) as OrderView;
    });
    expect(view.attemptedPizzerias).toEqual(['k1', 'k2', 'k3']);
    expect(calls.filter((c) => c === 'price')).toHaveLength(1); // price locked once
    expect(calls).toEqual(expect.arrayContaining(['release:k1', 'release:k2', 'void']));
    expect(view.status).toBe('cancelled');
  }, 30_000);

  it('fails with compensation when no kitchen ever accepts', async () => {
    const { acts, calls } = fakeActivities();
    const view = await withWorker(acts, async (taskQueue) =>
      env.client.workflow.execute('orderWorkflow', { taskQueue, workflowId: 'o-noaccept', args: [{ ...input('o-noaccept', { kitchenAccept: '300ms' }), maxRoutingAttempts: 2 }] }),
    );
    expect(view.status).toBe('failed');
    expect(view.failureReason).toBe('no_kitchen_accepted');
    expect(calls).toContain('void');
  }, 30_000);

  it('declined payment ends the order without kitchen involvement', async () => {
    const { acts, calls } = fakeActivities({ declinePayment: true });
    const view = await withWorker(acts, async (taskQueue) =>
      env.client.workflow.execute('orderWorkflow', { taskQueue, workflowId: 'o-decline', args: [input('o-decline')] }),
    );
    expect(view.status).toBe('failed');
    expect(view.failureReason).toBe('PaymentDeclined');
    expect(calls.some((c) => c.startsWith('notify:'))).toBe(false);
  }, 30_000);

  it('rejects cancellation once the courier has picked up', async () => {
    const { acts } = fakeActivities();
    const view = await withWorker(acts, async (taskQueue) => {
      const h = await env.client.workflow.start('orderWorkflow', { taskQueue, workflowId: 'o-late-cancel', args: [input('o-late-cancel')] });
      await until(h, (v) => v.status === 'payment_authorized');
      await h.signal(kitchenSignal, { action: 'accept' });
      await h.signal(kitchenSignal, { action: 'ready' });
      await until(h, (v) => v.delivery !== null);
      await h.signal(deliverySignal, { status: 'picked_up' });
      await until(h, (v) => v.status === 'out_for_delivery');
      await h.signal(cancelSignal, { reason: 'too late' });
      await until(h, (v) => v.timeline.some((e) => e.type === 'cancel_rejected'));
      await h.signal(deliverySignal, { status: 'delivered' });
      return (await h.result()) as OrderView;
    });
    expect(view.status).toBe('delivered');
  }, 30_000);
});
