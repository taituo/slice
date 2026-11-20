import { randomBytes } from 'node:crypto';
import { createCallback, getPool } from '@slice/db';
import { getTemporalClient, OPS_QUEUE } from './temporal';
import { callbackCancelSignal, callbackPressedSignal, type CallbackView } from './workflows/platform-defs';

/**
 * Entry point for every "call me back": physical buttons, the app, and the system itself (e.g. a
 * support case that missed its SLA). One live callback per customer: extra presses are signals
 * to it, a long press cancels it.
 */
export async function requestCallback(input: {
  customerId: string;
  tenantId: string;
  source: string;
  intent: CallbackView['intent'] | 'cancel';
  reason?: string;
  quiet?: { from: number; to: number; timezone: string } | null;
  timings?: { debounceMs?: number; maxAttempts?: number; retryDelayMs?: number; answerTimeoutMs?: number };
}): Promise<{ callbackId: string | null; status: 'started' | 'merged' | 'cancelled' | 'nothing_to_cancel' }> {
  const client = await getTemporalClient();
  const active = (
    await getPool().query(
      `SELECT id FROM callbacks WHERE customer_id=$1 AND status NOT IN ('completed','unreachable','cancelled') ORDER BY created_at DESC LIMIT 1`,
      [input.customerId],
    )
  ).rows[0]?.id as string | undefined;

  if (input.intent === 'cancel') {
    if (!active) return { callbackId: null, status: 'nothing_to_cancel' };
    await client.workflow.getHandle(active).signal(callbackCancelSignal);
    return { callbackId: active, status: 'cancelled' };
  }
  if (active) {
    try {
      await client.workflow.getHandle(active).signal(callbackPressedSignal, { intent: input.intent === 'reorder' ? 'reorder' : 'callback' });
      return { callbackId: active, status: 'merged' };
    } catch {
      /* the workflow just finished: start a new one below */
    }
  }
  const callbackId = `cb_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  await createCallback({ id: callbackId, customerId: input.customerId, tenantId: input.tenantId, source: input.source, intent: input.intent });
  await client.workflow.start('callbackWorkflow', {
    workflowId: callbackId,
    taskQueue: OPS_QUEUE,
    args: [{ callbackId, customerId: input.customerId, tenantId: input.tenantId, intent: input.intent, reason: input.reason, quiet: input.quiet ?? null, ...input.timings }],
  });
  return { callbackId, status: 'started' };
}
