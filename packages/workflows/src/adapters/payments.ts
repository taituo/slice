import { ApplicationFailure } from '@temporalio/common';

/**
 * Payment provider port. The golden sample ships FakePay; production plugs in Stripe/Adyen behind the
 * same four calls. Card data never touches our servers (hosted fields / payment sheets in clients),
 * which keeps the platform in PCI SAQ-A scope.
 */
export interface PaymentProvider {
  readonly name: string;
  authorize(orderId: string, amountCents: number, currency: string): Promise<{ ref: string }>;
  capture(ref: string, amountCents: number): Promise<void>;
  void(ref: string): Promise<void>;
  refund(ref: string, amountCents: number): Promise<void>;
}

export const PAYMENT_DECLINED = 'PaymentDeclined';

/** Deterministic fake: refs derive from the order id so retried activities are idempotent. Declines totals over €500. */
export class FakePay implements PaymentProvider {
  readonly name = 'fakepay';
  readonly ledger = new Map<string, { amount: number; state: 'authorized' | 'captured' | 'voided' | 'refunded' }>();

  async authorize(orderId: string, amountCents: number): Promise<{ ref: string }> {
    if (amountCents > 50_000) {
      throw ApplicationFailure.create({
        type: PAYMENT_DECLINED,
        message: 'Card declined: amount above limit',
        nonRetryable: true,
      });
    }
    const ref = `fp_${orderId}`;
    if (!this.ledger.has(ref)) this.ledger.set(ref, { amount: amountCents, state: 'authorized' });
    return { ref };
  }
  async capture(ref: string, amountCents: number) {
    this.ledger.set(ref, { amount: amountCents, state: 'captured' });
  }
  async void(ref: string) {
    const e = this.ledger.get(ref);
    if (e && e.state === 'authorized') e.state = 'voided';
  }
  async refund(ref: string, amountCents: number) {
    this.ledger.set(ref, { amount: amountCents, state: 'refunded' });
  }
}
