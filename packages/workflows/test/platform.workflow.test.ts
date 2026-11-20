import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import type { OfferDraft } from '@slice/shared';
import type { Activities } from '../src/activities';
import { bookingCancelSignal, bookingStatusQuery, caseCsatSignal, caseDecisionSignal, caseStatusQuery } from '../src/workflows/platform-defs';

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal(
    process.env.TEMPORAL_CLI_PATH ? { server: { executable: { type: 'existing-path', path: process.env.TEMPORAL_CLI_PATH } } } : {},
  );
  workflowBundle = await bundleWorkflowCode({ workflowsPath: resolve(__dirname, '../src/workflows/index.ts') });
}, 120_000);
afterAll(async () => {
  await env?.teardown();
});

async function withWorker<T>(acts: Partial<Activities>, fn: (taskQueue: string) => Promise<T>): Promise<T> {
  const taskQueue = `tq-${Math.random().toString(36).slice(2)}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle, activities: acts });
  return worker.runUntil(fn(taskQueue));
}

const offer = (providerId: string, priceCents: number, policy: OfferDraft['competePolicy'] = 'hold', floor = priceCents): OfferDraft => ({
  vertical: 'retail', providerId, providerName: providerId, listPriceCents: priceCents, priceCents, etaMinutes: null, distanceM: 50,
  headline: 'x', specialTitle: null, theme: {}, details: {}, floorPriceCents: floor, competePolicy: policy, round: 1,
});

describe('offerAuctionWorkflow', () => {
  it('collects offers inside the window, skips slow providers, runs a counter round', async () => {
    let saved: any[] = [];
    const acts: Partial<Activities> = {
      async findOfferCandidates() {
        return [{ vertical: 'retail', providerId: 'a' }, { vertical: 'retail', providerId: 'b' }, { vertical: 'retail', providerId: 'slow' }] as any;
      },
      async quoteCandidate(input: any) {
        if (input.candidate.providerId === 'slow') {
          await new Promise((r) => setTimeout(r, 2500));
          return [offer('slow', 5000)];
        }
        return input.candidate.providerId === 'a' ? [offer('a', 10000)] : [offer('b', 11000, 'beat', 9000)];
      },
      async saveOffers(input: any) {
        saved = input.offers;
        return input.offers.map((o: any, i: number) => ({ ...o, id: `o${i}`, expiresAt: '' }));
      },
    };
    const r: any = await withWorker(acts, (taskQueue) =>
      env.client.workflow.execute('offerAuctionWorkflow', {
        taskQueue,
        workflowId: `auction-${Date.now()}`,
        args: [{ requestId: 'r1', tenantId: 't', vertical: 'retail', lat: 0, lng: 0, customerKey: 'c', preference: 'cheapest', windowMs: 600 }],
      }),
    );
    expect(r.providersAsked).toBe(3);
    expect(r.providersAnswered).toBe(2);
    expect(saved.map((o) => o.providerId)).toEqual(['b', 'a']); // b beat a in round 2
    expect(saved[0].priceCents).toBe(9800);
    expect(r.countered).toBe(1);
  }, 30_000);
});

describe('classBookingWorkflow', () => {
  it('a cancellation promotes the waitlisted booking', async () => {
    const statuses: Record<string, string> = {};
    const acts: Partial<Activities> = {
      async reserveSpot({ bookingId }) {
        return bookingId === 'first' ? { status: 'confirmed', position: 0 } : { status: 'waitlisted', position: 1 };
      },
      async setBookingStatus({ bookingId, status }) {
        statuses[bookingId] = status;
      },
      async promoteFromWaitlist() {
        await env.client.workflow.getHandle('second').signal('promoted');
        return 'second';
      },
      async notifyCustomer() {},
    };
    await withWorker(acts, async (taskQueue) => {
      const startsAt = new Date(Date.now() + 60_000).toISOString();
      const base = { classId: 'c1', customerId: 'u', startsAt, durationMin: 1, remindBeforeMin: 0 };
      const a = await env.client.workflow.start('classBookingWorkflow', { taskQueue, workflowId: 'first', args: [{ ...base, bookingId: 'first' }] });
      const b = await env.client.workflow.start('classBookingWorkflow', { taskQueue, workflowId: 'second', args: [{ ...base, bookingId: 'second' }] });
      for (let i = 0; i < 50 && (await b.query(bookingStatusQuery)).status !== 'waitlisted'; i++) await new Promise((r) => setTimeout(r, 50));
      await a.signal(bookingCancelSignal);
      expect((await a.result()).status).toBe('cancelled');
      for (let i = 0; i < 50 && (await b.query(bookingStatusQuery)).status !== 'confirmed'; i++) await new Promise((r) => setTimeout(r, 50));
      expect((await b.query(bookingStatusQuery)).status).toBe('confirmed');
      await b.signal(bookingCancelSignal);
      await b.result();
    });
    expect(statuses.first).toBe('cancelled');
  }, 30_000);
});

describe('supportCaseWorkflow', () => {
  const base = (triage: any, applied: number[]) => ({
    async triageCase() {
      return triage;
    },
    async supportMessage() {},
    async setCaseStatus() {},
    async applyResolution(i: any) {
      applied.push(i.amountCents);
      return { ok: true };
    },
    async notifyCustomer() {},
  });

  it('auto-applies a small refund and closes after the rating', async () => {
    const applied: number[] = [];
    const v: any = await withWorker(base({ category: 'missing_item', action: 'refund', amountCents: 600, autoApprove: true, reply: 'Refunded' }, applied) as any, async (taskQueue) => {
      const h = await env.client.workflow.start('supportCaseWorkflow', { taskQueue, workflowId: `case-${Date.now()}`, args: [{ caseId: 'c', customerId: 'u', orderId: 'o', message: 'missing', csatDelayMs: 60_000 }] });
      for (let i = 0; i < 50 && (await h.query(caseStatusQuery)).status !== 'resolved'; i++) await new Promise((r) => setTimeout(r, 50));
      await h.signal(caseCsatSignal, { score: 4 });
      return h.result();
    });
    expect(applied).toEqual([600]);
    expect(v.status).toBe('closed');
  }, 30_000);

  it('waits for a person above the limit, flags the SLA breach, then pays the approved amount', async () => {
    const applied: number[] = [];
    const v: any = await withWorker(base({ category: 'wrong_item', action: 'refund', amountCents: 3000, autoApprove: false, reply: 'Checking' }, applied) as any, async (taskQueue) => {
      const h = await env.client.workflow.start('supportCaseWorkflow', {
        taskQueue,
        workflowId: `case-${Date.now()}`,
        args: [{ caseId: 'c', customerId: 'u', orderId: 'o', message: 'wrong', approvalSlaMs: 300, csatDelayMs: 100, csatWaitMs: 100 }],
      });
      for (let i = 0; i < 60 && (await h.query(caseStatusQuery)).status !== 'sla_breached'; i++) await new Promise((r) => setTimeout(r, 50));
      expect((await h.query(caseStatusQuery)).status).toBe('sla_breached');
      expect(applied).toEqual([]);
      await h.signal(caseDecisionSignal, { approve: true, amountCents: 2000 });
      return h.result();
    });
    expect(applied).toEqual([2000]);
    expect(v.status).toBe('closed');
  }, 30_000);
});
