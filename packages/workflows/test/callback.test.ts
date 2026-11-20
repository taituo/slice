import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { quietDelayMs } from '../src/activities/platform';
import { callbackCancelSignal, callbackOutcomeSignal, callbackPressedSignal, callbackStatusQuery } from '../src/workflows/platform-defs';

describe('quiet hours', () => {
  const tz = 'Europe/Berlin';
  it('is zero outside the window and counts down to its end inside it', () => {
    // 2026-11-20 21:30 Berlin = 20:30 UTC
    const now = new Date('2026-11-20T20:30:00Z');
    expect(quietDelayMs({ from: 8, to: 20, timezone: tz }, now)).toBe(0);
    expect(quietDelayMs({ from: 21, to: 22, timezone: tz }, now)).toBe(30 * 60_000);
    // overnight window 22→8 at 23:00 Berlin: 9 hours to wait
    expect(quietDelayMs({ from: 22, to: 8, timezone: tz }, new Date('2026-11-20T22:00:00Z'))).toBe(9 * 3600_000);
    expect(quietDelayMs(null, now)).toBe(0);
  });
});

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

function fakes(log: string[]) {
  return {
    async quietDelay() {
      return 0;
    },
    async updateCallback(i: any) {
      if (i.status) log.push(`status:${i.status}`);
    },
    async callbackContext() {
      return { firstName: 'Ada', lastOrder: null, usual: null, openCases: [], upcomingBookings: [] };
    },
    async seedCallbackSession() {
      log.push('seeded');
    },
    async placeCallbackCall() {
      log.push('call');
      return { conversationId: `conv_${log.length}`, dryRun: true, reachable: true };
    },
    async notifyCustomer(i: any) {
      log.push(`notify:${i.channels.join(',')}`);
    },
  };
}

async function run<T>(log: string[], fn: (taskQueue: string) => Promise<T>) {
  const taskQueue = `cb-${Math.random().toString(36).slice(2)}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle, activities: fakes(log) as any });
  return worker.runUntil(fn(taskQueue));
}

describe('callbackWorkflow', () => {
  it('merges presses into one call and completes on the post-call outcome', async () => {
    const log: string[] = [];
    const v: any = await run(log, async (taskQueue) => {
      const h = await env.client.workflow.start('callbackWorkflow', {
        taskQueue,
        workflowId: `cb-${Date.now()}`,
        args: [{ callbackId: 'cb1', customerId: 'u', tenantId: 't', intent: 'callback', debounceMs: 500, answerTimeoutMs: 10_000 }],
      });
      for (let i = 0; i < 4; i++) await h.signal(callbackPressedSignal, {});
      for (let i = 0; i < 60 && (await h.query(callbackStatusQuery)).status !== 'calling'; i++) await new Promise((r) => setTimeout(r, 50));
      await h.signal(callbackOutcomeSignal, { status: 'completed' });
      return h.result();
    });
    expect(v.presses).toBe(5);
    expect(log.filter((x) => x === 'call')).toHaveLength(1);
    expect(v.status).toBe('completed');
  }, 30_000);

  it('retries unanswered calls, then texts', async () => {
    const log: string[] = [];
    const v: any = await run(log, (taskQueue) =>
      env.client.workflow.execute('callbackWorkflow', {
        taskQueue,
        workflowId: `cb-${Date.now()}`,
        args: [{ callbackId: 'cb2', customerId: 'u', tenantId: 't', intent: 'callback', debounceMs: 50, maxAttempts: 2, retryDelayMs: 100, answerTimeoutMs: 200 }],
      }),
    );
    expect(log.filter((x) => x === 'call')).toHaveLength(2);
    expect(log).toContain('notify:sms');
    expect(v.status).toBe('unreachable');
  }, 30_000);

  it('a long press during the debounce cancels without calling', async () => {
    const log: string[] = [];
    const v: any = await run(log, async (taskQueue) => {
      const h = await env.client.workflow.start('callbackWorkflow', {
        taskQueue,
        workflowId: `cb-${Date.now()}`,
        args: [{ callbackId: 'cb3', customerId: 'u', tenantId: 't', intent: 'callback', debounceMs: 2000 }],
      });
      await h.signal(callbackCancelSignal);
      return h.result();
    });
    expect(v.status).toBe('cancelled');
    expect(log).not.toContain('call');
  }, 30_000);
});
