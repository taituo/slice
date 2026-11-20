import {
  condition,
  proxyLocalActivities,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import { counterRound, rankOffers, type OfferDraft, type OfferPreference } from '@slice/shared/src/offers';
import type { Activities } from '../activities';
import type { OfferRequestInput, Triage } from '../activities/platform';
import {
  voucherRedeemedSignal,
  bookingStatusQuery,
  bookingCancelSignal,
  bookingCheckInSignal,
  bookingPromotedSignal,
  caseStatusQuery,
  caseDecisionSignal,
  caseCustomerMessageSignal,
  caseCsatSignal,
  agentTaskQuery,
  type CaseView,
} from './platform-defs';

const acts = proxyActivities<Activities>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '1 second', maximumAttempts: 6 },
});
/**
 * Auctions are latency-critical reads: quotes run as local activities (in the worker, no task-queue
 * round trip through the Temporal server). Local activities hold the workflow task while they run,
 * so the bidding window is enforced as each quote's own timeout, not with a timer.
 */
const auctionActs = proxyLocalActivities<Activities>({ startToCloseTimeout: '10 seconds', retry: { maximumAttempts: 3 } });

// =================================================================== competing offers

export interface AuctionInput extends OfferRequestInput {
  preference: OfferPreference;
  /** How long providers get to answer (ms). The round ends early when all have answered. */
  windowMs?: number;
  rounds?: 1 | 2;
  ttlSeconds?: number;
}

/**
 * Reverse auction: every provider in range quotes in parallel within a time window, providers with
 * a match/beat policy may counter, the result is ranked for the customer's preference and stored.
 */
export async function offerAuctionWorkflow(input: AuctionInput) {
  const candidates = await auctionActs.findOfferCandidates(input);
  const quoteActs = proxyLocalActivities<Activities>({ startToCloseTimeout: input.windowMs ?? 1500, retry: { maximumAttempts: 1 } });
  const drafts: OfferDraft[] = [];
  let answered = 0;
  await Promise.all(
    candidates.map((candidate) =>
      quoteActs
        .quoteCandidate({ ...input, candidate })
        .then((d) => {
          drafts.push(...d);
          answered++;
        })
        .catch(() => undefined), // too slow or failed: left out of this round
    ),
  );
  const round1 = [...drafts];
  const final = (input.rounds ?? 2) === 2 ? counterRound(round1) : round1;
  const ranked = rankOffers(final, input.preference).slice(0, 8);
  const saved = await auctionActs.saveOffers({ requestId: input.requestId, offers: ranked, ttlSeconds: input.ttlSeconds ?? 600 });
  return {
    requestId: input.requestId,
    providersAsked: candidates.length,
    providersAnswered: answered,
    countered: final.filter((o) => o.round > 1).length,
    offers: saved,
  };
}

/** Retail voucher lifetime: expires unless redeemed in time. */
export async function voucherWorkflow(input: { code: string; ttlMs: number }) {
  let redeemed = false;
  setHandler(voucherRedeemedSignal, () => void (redeemed = true));
  if (await condition(() => redeemed, input.ttlMs)) return { code: input.code, status: 'redeemed' };
  await acts.expireVoucher({ code: input.code });
  return { code: input.code, status: 'expired' };
}

// =================================================================== fitness bookings


export interface BookingInput {
  bookingId: string;
  classId: string;
  customerId: string;
  startsAt: string;
  durationMin: number;
  /** Minutes before start to remind; default 120. */
  remindBeforeMin?: number;
  notifyBy?: Array<'sms' | 'call' | 'push' | 'email'>;
}

/**
 * A class booking from request to attendance. Waitlisted bookings wait for a freed spot until the
 * class starts; a cancellation hands the spot to the next person automatically.
 */
export async function classBookingWorkflow(input: BookingInput) {
  const state = { bookingId: input.bookingId, status: 'pending', position: 0, reminded: false };
  let cancelled = false;
  let checkedIn = false;
  let promoted = false;
  setHandler(bookingStatusQuery, () => state);
  setHandler(bookingCancelSignal, () => {
    if (['pending', 'confirmed', 'waitlisted'].includes(state.status)) cancelled = true;
  });
  setHandler(bookingCheckInSignal, () => void (checkedIn = true));
  setHandler(bookingPromotedSignal, () => void (promoted = true));

  const start = Date.parse(input.startsAt);
  const end = start + input.durationMin * 60_000;
  const notify = (message: string) =>
    acts.notifyCustomer({ customerId: input.customerId, channels: input.notifyBy ?? ['push'], message, callPurpose: 'class_booking' });

  const r = await acts.reserveSpot({ bookingId: input.bookingId });
  state.status = r.status;
  state.position = r.position;
  await notify(r.status === 'confirmed' ? 'Your class is booked.' : `The class is full. You're number ${r.position} on the waitlist.`);

  if (state.status === 'waitlisted') {
    await condition(() => promoted || cancelled, Math.max(1, start - Date.now()));
    if (cancelled) {
      await acts.setBookingStatus({ bookingId: input.bookingId, status: 'cancelled' });
      state.status = 'cancelled';
      return state;
    }
    if (!promoted) {
      await acts.setBookingStatus({ bookingId: input.bookingId, status: 'expired' });
      state.status = 'expired';
      return state;
    }
    state.status = 'confirmed';
    state.position = 0;
    await notify("A spot opened up: you're in!");
  }

  const remindAt = start - (input.remindBeforeMin ?? 120) * 60_000;
  if (remindAt > Date.now() && !(await condition(() => cancelled, remindAt - Date.now()))) {
    await notify('Reminder: your class starts soon.');
    state.reminded = true;
  }

  await condition(() => cancelled || checkedIn, Math.max(1, start - Date.now()));
  if (cancelled && !checkedIn) {
    await acts.setBookingStatus({ bookingId: input.bookingId, status: 'cancelled' });
    state.status = 'cancelled';
    await acts.promoteFromWaitlist({ classId: input.classId }); // the activity notifies the promoted booking
    return state;
  }
  // Doors open: check-in allowed until the class ends.
  if (!checkedIn) await condition(() => checkedIn, Math.max(1, end - Date.now()));
  state.status = checkedIn ? 'attended' : 'no_show';
  await acts.setBookingStatus({ bookingId: input.bookingId, status: state.status });
  return state;
}

// =================================================================== support cases



export interface SupportInput {
  caseId: string;
  customerId: string | null;
  orderId?: string | null;
  message: string;
  approvalSlaMs?: number;
  csatDelayMs?: number;
  csatWaitMs?: number;
}

/**
 * Support case: triage on arrival, fix small issues instantly within policy, ask a person for the
 * rest (with an SLA and escalation), then follow up for a satisfaction score.
 */
export async function supportCaseWorkflow(input: SupportInput): Promise<CaseView> {
  const view: CaseView = { caseId: input.caseId, status: 'open', category: null, action: null, amountCents: 0, replies: [] };
  let decision: { approve: boolean; amountCents?: number; note?: string } | null = null;
  let csat: number | null = null;
  const inbox: string[] = [];
  setHandler(caseStatusQuery, () => view);
  setHandler(caseDecisionSignal, (d) => void (decision = d));
  setHandler(caseCsatSignal, (s) => void (csat = Math.max(1, Math.min(5, Math.round(s.score)))));
  setHandler(caseCustomerMessageSignal, (m) => void inbox.push(m.body));

  const say = async (body: string) => {
    view.replies.push(body);
    await acts.supportMessage({ caseId: input.caseId, author: 'agent', body });
  };
  const tellCustomer = async (message: string) => {
    if (input.customerId) await acts.notifyCustomer({ customerId: input.customerId, channels: ['push'], message, callPurpose: 'support' });
  };

  const t: Triage = await acts.triageCase({ caseId: input.caseId, message: input.message, orderId: input.orderId });
  view.category = t.category;
  view.action = t.action;
  view.status = 'triaged';
  await say(t.reply);

  const resolve = async (amount: number, resolution: string) => {
    if (amount > 0 && (t.action === 'refund' || t.action === 'credit')) {
      await acts.applyResolution({ caseId: input.caseId, orderId: input.orderId, action: t.action, amountCents: amount });
      view.amountCents = amount;
    }
    view.status = 'resolved';
    await acts.setCaseStatus({ caseId: input.caseId, status: 'resolved', resolution, creditCents: amount });
  };

  if (t.action === 'none') {
    await resolve(0, 'information given');
  } else if (t.autoApprove) {
    await resolve(t.amountCents, `${t.action} applied automatically by policy`);
    await tellCustomer(t.reply);
  } else {
    const waiting = t.action === 'escalate' ? 'escalated' : 'awaiting_approval';
    await acts.setCaseStatus({ caseId: input.caseId, status: waiting });
    view.status = waiting; // after the write, so readers of the query never see a state the DB lacks
    await acts.notifyCustomer({ customerId: 'ops-support', channels: ['email'], message: `Case ${input.caseId} needs a decision (${t.category})` }).catch(() => undefined);
    if (!(await condition(() => decision !== null, input.approvalSlaMs ?? 15 * 60_000))) {
      // SLA missed: page the duty lead and keep waiting for a person.
      view.status = 'sla_breached';
      await acts.setCaseStatus({ caseId: input.caseId, status: 'sla_breached' });
      await acts.supportMessage({ caseId: input.caseId, author: 'system', body: 'Approval SLA missed; duty lead paged; the AI calls the customer back.' });
      // Fully agentic follow-up: the agent phones the customer instead of leaving them waiting.
      if (input.customerId) await acts.requestCallback({ customerId: input.customerId, tenantId: 'slice', reason: `case ${input.caseId} SLA breached` }).catch(() => undefined);
      await condition(() => decision !== null, '24 hours');
    }
    const d = decision as { approve: boolean; amountCents?: number; note?: string } | null;
    if (d?.approve) {
      await resolve(d.amountCents ?? t.amountCents, d.note ?? 'approved by support team');
      await say(`Our team approved it: €${((d.amountCents ?? t.amountCents) / 100).toFixed(2)} is on its way back to you.`);
    } else {
      view.status = 'resolved';
      await acts.setCaseStatus({ caseId: input.caseId, status: 'resolved', resolution: d?.note ?? 'closed without compensation' });
      await say(d?.note ?? 'Our team reviewed this and replied by email.');
    }
  }

  // Follow-up: messages that arrived meanwhile get an acknowledgement, then a satisfaction survey.
  for (const m of inbox.splice(0)) await acts.supportMessage({ caseId: input.caseId, author: 'customer', body: m });
  await condition(() => csat !== null, input.csatDelayMs ?? 60 * 60_000);
  if (csat === null) {
    await tellCustomer('How did we do? Reply 1–5.');
    await condition(() => csat !== null, input.csatWaitMs ?? 3 * 24 * 3600_000);
  }
  view.status = 'closed';
  await acts.setCaseStatus({ caseId: input.caseId, status: 'closed', csat: csat ?? undefined });
  return view;
}

// =================================================================== ads

/** Every 30 minutes: generate ads for what's true right now, pause losing variants, end expired ones. */
export async function adOptimizerWorkflow(input: { minImpressions?: number } = {}) {
  const generated = await acts.generateAds();
  const pruned = await acts.pruneAds({ minImpressions: input.minImpressions });
  return { ...generated, paused: pruned.paused };
}

// =================================================================== durable agent tasks (A2A async)


/** A2A `message/send` with blocking=false: the turn runs durably; `tasks/get` queries this workflow. */
export async function agentTaskWorkflow(input: { tenantId: string; sessionId: string; text: string; customerToken?: string | null }) {
  const task = { state: 'working', reply: null as string | null, ui: [] as unknown[], error: null as string | null };
  setHandler(agentTaskQuery, () => task);
  try {
    const r = await acts.runAgentTurn(input);
    task.reply = r.reply;
    task.ui = r.ui;
    task.state = 'completed';
  } catch (err) {
    task.error = (err as Error).message;
    task.state = 'failed';
  }
  return task;
}
