import { defineQuery, defineSignal } from '@temporalio/workflow';

/** Signals and queries of the platform workflows (safe to import from API code). */

export interface CaseView {
  caseId: string;
  status: string;
  category: string | null;
  action: string | null;
  amountCents: number;
  replies: string[];
}

export const voucherRedeemedSignal = defineSignal('redeemed');
export const bookingStatusQuery = defineQuery<{ bookingId: string; status: string; position: number; reminded: boolean }>('bookingStatus');
export const bookingCancelSignal = defineSignal('cancelBooking');
export const bookingCheckInSignal = defineSignal('checkIn');
export const bookingPromotedSignal = defineSignal('promoted');
export const caseStatusQuery = defineQuery<CaseView>('caseStatus');
export const caseDecisionSignal = defineSignal<[{ approve: boolean; amountCents?: number; note?: string }]>('decision');
export const caseCustomerMessageSignal = defineSignal<[{ body: string }]>('customerMessage');
export const caseCsatSignal = defineSignal<[{ score: number }]>('csat');
export const agentTaskQuery = defineQuery<{ state: string; reply: string | null; ui: unknown[]; error: string | null }>('agentTask');

// ---------------------------------------------------------------- AI callbacks

export interface CallbackView {
  callbackId: string;
  intent: 'callback' | 'reorder' | 'support_followup';
  status: string; // requested → (scheduled) → preparing → calling → completed | retry_scheduled | unreachable | cancelled
  presses: number;
  attempts: number;
  conversationId: string | null;
  offer: { offerId: string; providerName: string; headline: string; priceCents: number } | null;
  opener: string | null;
}
export const callbackStatusQuery = defineQuery<CallbackView>('callbackStatus');
/** Another press while the callback is pending: counted, and a double press can upgrade to "my usual". */
export const callbackPressedSignal = defineSignal<[{ intent?: 'callback' | 'reorder' }]>('pressed');
export const callbackCancelSignal = defineSignal('cancelCallback');
/** From the ElevenLabs post-call webhook (or call-initiation failure). */
export const callbackOutcomeSignal = defineSignal<[{ status: 'completed' | 'no_answer' | 'failed'; summary?: string }]>('callOutcome');
