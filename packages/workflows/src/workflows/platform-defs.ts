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
