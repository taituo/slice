import { condition, executeChild, proxyActivities, setHandler } from '@temporalio/workflow';
import type { Activities } from '../activities';
import { offerAuctionWorkflow } from './platform';
import {
  callbackCancelSignal,
  callbackOutcomeSignal,
  callbackPressedSignal,
  callbackStatusQuery,
  type CallbackView,
} from './platform-defs';

const acts = proxyActivities<Activities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 5 } });

export interface CallbackInput {
  callbackId: string;
  customerId: string;
  tenantId: string;
  intent: CallbackView['intent'];
  reason?: string;
  quiet?: { from: number; to: number; timezone: string } | null;
  /** Presses arriving within this window are one request (and a double press can upgrade it). */
  debounceMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  /** How long to wait for the call's outcome before treating it as unanswered. */
  answerTimeoutMs?: number;
}

const euro = (c: number) => `€${(c / 100).toFixed(2)}`;

/**
 * "Call me back": a button press (physical or in the app) or the system itself asks the AI to phone
 * the customer. The workflow collects presses, respects quiet hours, prepares context (and, for
 * "my usual", runs an offer auction so the agent can propose the best price), places the call
 * through ElevenLabs with our deep agent as the voice, retries unanswered calls and finally texts.
 */
export async function callbackWorkflow(input: CallbackInput): Promise<CallbackView> {
  const view: CallbackView = {
    callbackId: input.callbackId,
    intent: input.intent,
    status: 'requested',
    presses: 1,
    attempts: 0,
    conversationId: null,
    offer: null,
    opener: null,
  };
  let cancelled = false;
  let outcome: { status: 'completed' | 'no_answer' | 'failed'; summary?: string } | null = null;
  setHandler(callbackStatusQuery, () => view);
  setHandler(callbackPressedSignal, (p) => {
    view.presses++;
    if (p.intent === 'reorder' && view.status === 'requested') view.intent = 'reorder';
  });
  setHandler(callbackCancelSignal, () => {
    if (!['calling', 'completed', 'unreachable'].includes(view.status)) cancelled = true;
  });
  setHandler(callbackOutcomeSignal, (o) => void (outcome = o));

  const set = async (status: string, extra: Record<string, unknown> = {}) => {
    view.status = status;
    await acts.updateCallback({ callbackId: input.callbackId, status, presses: view.presses, ...extra });
  };
  const stopIfCancelled = async () => {
    if (!cancelled) return false;
    await set('cancelled', { outcome: 'cancelled by the customer' });
    return true;
  };

  // 1. Collect presses: five quick presses are still one call.
  await condition(() => cancelled, input.debounceMs ?? 4000);
  if (await stopIfCancelled()) return view;

  // 2. Quiet hours: wait (durably) until morning unless cancelled.
  const delay = await acts.quietDelay({ quiet: input.quiet ?? null });
  if (delay > 0) {
    await set('scheduled', { scheduledFor: new Date(Date.now() + delay).toISOString() });
    await condition(() => cancelled, delay);
    if (await stopIfCancelled()) return view;
  }

  // 3. Prepare: what does the agent need to know before it dials?
  await set('preparing');
  const ctx = await acts.callbackContext({ customerId: input.customerId });
  const hi = ctx.firstName ? `Hi ${ctx.firstName}` : 'Hi';
  let opener = `${hi}, you asked us to call you back. How can I help?`;
  let note = '';
  if (view.intent === 'reorder' && ctx.usual) {
    // Let nearby kitchens compete for "the usual" before we call: the agent proposes the winner.
    const requestId = `rfq_${input.callbackId.replace(/[^a-z0-9]/gi, '')}`;
    await acts.openOfferRequest({ requestId, tenantId: input.tenantId, customerId: input.customerId, lat: ctx.usual.lat, lng: ctx.usual.lng, items: ctx.usual.items });
    const auction = await executeChild(offerAuctionWorkflow, {
      workflowId: `${input.callbackId}-auction`,
      args: [
        {
          requestId,
          tenantId: input.tenantId,
          vertical: 'food',
          lat: ctx.usual.lat,
          lng: ctx.usual.lng,
          items: ctx.usual.items,
          customerKey: input.customerId,
          preference: 'best_value',
        },
      ],
    });
    const best = auction.offers[0];
    if (best) {
      view.offer = { offerId: best.id, providerName: best.providerName, headline: best.headline, priceCents: best.priceCents };
      opener = `${hi}, it's about your usual: ${best.headline.replace(/ from .*$/, '')} from ${best.providerName} for ${euro(best.priceCents)}${best.etaMinutes ? `, about ${best.etaMinutes} minutes` : ''}. Shall I order it?`;
      note = `[pending offer ${best.id}]`;
    } else {
      opener = `${hi}, you asked for your usual, but every kitchen near you is full right now. Shall I try again in a bit?`;
    }
  } else if (view.intent === 'reorder') {
    view.intent = 'callback';
    opener = `${hi}, you pressed for your usual order, but I don't have a previous order yet. What would you like?`;
  } else if (view.intent === 'support_followup' || ctx.openCases.length) {
    const c = ctx.openCases[0];
    opener = c
      ? `${hi}, I'm calling about your support case (${String(c.category ?? 'your issue').replace(/_/g, ' ')}). Sorry for the wait. Can I help sort it out now?`
      : `${hi}, I'm following up on your recent issue. Is everything sorted?`;
  } else if (ctx.lastOrder && !['delivered', 'cancelled', 'failed'].includes(ctx.lastOrder.status)) {
    opener = `${hi}, about your order from ${ctx.lastOrder.pizzeria ?? 'us'}: it's ${String(ctx.lastOrder.status).replace(/_/g, ' ')}. What can I do for you?`;
  } else if (ctx.upcomingBookings.length) {
    const b = ctx.upcomingBookings[0]!;
    opener = `${hi}, you have ${b.title} coming up. Is it about that, or something else?`;
  }
  view.opener = opener;
  await acts.updateCallback({ callbackId: input.callbackId, context: { ...ctx, opener, offer: view.offer, reason: input.reason ?? null } });
  await acts.seedCallbackSession({ sessionId: `callback-${input.callbackId}`, tenantId: input.tenantId, customerId: input.customerId, opener, note });
  if (await stopIfCancelled()) return view;

  // 4. Call, retry if unanswered.
  const max = input.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= max; attempt++) {
    view.attempts = attempt;
    outcome = null;
    const call = await acts.placeCallbackCall({
      callbackId: input.callbackId,
      customerId: input.customerId,
      purpose: `callback_${view.intent}`,
      opener,
      variables: { tenant: input.tenantId, intent: view.intent },
    });
    if (!call.reachable) break;
    view.conversationId = call.conversationId;
    await set('calling', { attempts: attempt, conversationId: call.conversationId });
    await condition(() => outcome !== null, input.answerTimeoutMs ?? 10 * 60_000);
    const o = outcome as { status: string; summary?: string } | null;
    if (o?.status === 'completed') {
      await set('completed', { outcome: o.summary ?? 'call completed' });
      return view;
    }
    if (attempt < max) {
      await set('retry_scheduled');
      await condition(() => cancelled, input.retryDelayMs ?? 3 * 60_000);
      if (await stopIfCancelled()) return view;
    }
  }

  // 5. Unreachable: leave a text with a way back in.
  await acts.notifyCustomer({
    customerId: input.customerId,
    channels: ['sms'],
    message: `We tried to call you back${view.offer ? ` about your usual (${view.offer.headline}, ${euro(view.offer.priceCents)})` : ''}. Reply or open the app to continue.`,
  });
  await set('unreachable', { outcome: `no answer after ${view.attempts} attempt(s); SMS sent` });
  return view;
}
