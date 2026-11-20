import * as repo from '@slice/db';
import { thompsonPick, type CartLine, type OfferPreference, type Vertical } from '@slice/shared';
import {
  bookingCancelSignal,
  bookingCheckInSignal,
  bookingStatusQuery,
  caseCsatSignal,
  caseCustomerMessageSignal,
  caseDecisionSignal,
  caseStatusQuery,
  getTemporalClient,
  OPS_QUEUE,
  ORDERS_QUEUE,
  voucherRedeemedSignal,
} from '@slice/workflows';
import { WorkflowNotFoundError } from '@temporalio/client';
import { contactFor, placeOrder, ServiceError } from './services';

/**
 * Platform services shared by every vertical and every channel: competing offers, bookings,
 * retail vouchers, support cases and ads. Long-running parts are Temporal workflows.
 */

// ------------------------------------------------------------------ competing offers

export async function requestOffers(input: {
  tenantId: string;
  vertical: Vertical;
  lat: number;
  lng: number;
  query?: string;
  items?: CartLine[];
  preference?: OfferPreference;
  customerKey: string;
  windowMs?: number;
}) {
  if (input.vertical === 'food' && !input.items?.length) throw new ServiceError(422, 'items_required', 'Food offers need a cart (items).');
  const requestId = repo.newId('rfq');
  const preference = input.preference ?? 'best_value';
  await repo.createOfferRequest({
    id: requestId,
    tenantId: input.tenantId,
    vertical: input.vertical,
    customerKey: input.customerKey,
    lat: input.lat,
    lng: input.lng,
    request: { query: input.query, items: input.items },
    preference,
  });
  const client = await getTemporalClient();
  const result = await client.workflow.execute('offerAuctionWorkflow', {
    workflowId: requestId,
    taskQueue: ORDERS_QUEUE,
    args: [{ ...input, requestId, preference, windowMs: input.windowMs ?? 1500 }],
  });
  return result as {
    requestId: string;
    providersAsked: number;
    providersAnswered: number;
    countered: number;
    offers: Array<{ id: string; vertical: string; providerName: string; headline: string; priceCents: number; listPriceCents: number; etaMinutes: number | null; distanceM: number; specialTitle: string | null; theme: any; round: number; score: number; expiresAt: string }>;
  };
}

/** Accepting an offer places the order, books the class or issues the voucher. */
export async function chooseOffer(input: {
  offerId: string;
  customerId: string | null;
  name?: string;
  phone?: string;
  addressLine?: string;
  channel: string;
  /** Retail voucher lifetime; tests use short ones. */
  voucherTtlSeconds?: number;
}) {
  const offer = await repo.getOffer(input.offerId);
  if (!offer) throw new ServiceError(404, 'not_found', 'Offer not found');
  if (!(await repo.acceptOffer(input.offerId))) throw new ServiceError(409, 'offer_unavailable', 'That offer has expired or was already decided');
  const req = (await repo.getPool().query(`SELECT lat, lng FROM offer_requests WHERE id=$1`, [offer.requestId])).rows[0];

  if (offer.vertical === 'food') {
    const who = await contactFor(input.customerId, input);
    const d = offer.details as { items: CartLine[] };
    const placed = await placeOrder({
      customer: who,
      delivery: { lat: req.lat, lng: req.lng, addressLine: input.addressLine ?? 'Usual delivery address' },
      items: d.items,
      channel: (['web', 'mobile', 'xr', 'agent', 'mcp', 'a2a', 'voice'].includes(input.channel) ? input.channel : 'agent') as any,
      offerId: offer.id,
    });
    return { vertical: 'food', ...placed, priceCents: offer.priceCents, providerName: offer.providerName };
  }
  if (offer.vertical === 'fitness') {
    const d = offer.details as { classId: string };
    const booking = await bookClass({ classId: d.classId, customerId: input.customerId, name: input.name, phone: input.phone, priceCents: offer.priceCents, offerId: offer.id });
    return { vertical: 'fitness', ...booking, priceCents: offer.priceCents, providerName: offer.providerName };
  }
  const v = await repo.issueVoucher(offer.id, offer.customerKey, (input.voucherTtlSeconds ?? 1800) / 60);
  const client = await getTemporalClient();
  await client.workflow.start('voucherWorkflow', {
    workflowId: `voucher-${v.code}`,
    taskQueue: OPS_QUEUE,
    args: [{ code: v.code, ttlMs: Date.parse(v.expiresAt) - Date.now() }],
  });
  return {
    vertical: 'retail',
    code: v.code,
    expiresAt: v.expiresAt,
    providerName: offer.providerName,
    headline: offer.headline,
    priceCents: offer.priceCents,
    place: (offer.details as { place?: string }).place ?? null,
    theme: offer.theme,
  };
}

export async function redeemVoucher(code: string, merchantId: string) {
  const v = await repo.getVoucher(code);
  if (!v || v.merchantId !== merchantId) throw new ServiceError(404, 'not_found', 'Unknown voucher for this shop');
  if (!(await repo.setVoucherStatus(code, 'redeemed'))) throw new ServiceError(409, 'voucher_not_valid', `Voucher is ${v.status}`);
  const client = await getTemporalClient();
  await client.workflow.getHandle(`voucher-${code}`).signal(voucherRedeemedSignal).catch(() => undefined);
  return { ok: true, priceCents: v.priceCents, headline: v.headline };
}

// ------------------------------------------------------------------ fitness

export async function bookClass(input: { classId: string; customerId: string | null; name?: string; phone?: string; priceCents?: number; offerId?: string | null; remindBeforeMin?: number }) {
  const cls = await repo.getClass(input.classId);
  if (!cls) throw new ServiceError(404, 'not_found', 'Class not found');
  if (Date.parse(cls.startsAt) <= Date.now()) throw new ServiceError(409, 'class_started', 'That class has already started');
  let customerId = input.customerId;
  if (!customerId) {
    const who = await contactFor(null, input);
    customerId = await repo.upsertCustomer({ name: who.name, phone: who.phone, region: 'de-berlin' });
  }
  const bookingId = repo.newId('bk');
  await repo.createBooking({ id: bookingId, classId: cls.id, customerId, priceCents: input.priceCents ?? cls.priceCents, offerId: input.offerId });
  const client = await getTemporalClient();
  const handle = await client.workflow.start('classBookingWorkflow', {
    workflowId: bookingId,
    taskQueue: ORDERS_QUEUE,
    args: [{ bookingId, classId: cls.id, customerId, startsAt: cls.startsAt, durationMin: cls.durationMin, remindBeforeMin: input.remindBeforeMin }],
  });
  // Wait briefly for the reservation so the caller learns confirmed vs waitlisted.
  for (let i = 0; i < 40; i++) {
    const s = await handle.query(bookingStatusQuery).catch(() => null);
    if (s && s.status !== 'pending') return { bookingId, status: s.status, position: s.position, title: cls.title, gymName: cls.gymName, startsAt: cls.startsAt };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { bookingId, status: 'pending', position: 0, title: cls.title, gymName: cls.gymName, startsAt: cls.startsAt };
}

export async function bookingStatus(bookingId: string) {
  const row = await repo.getBooking(bookingId);
  if (!row) throw new ServiceError(404, 'not_found', 'Booking not found');
  try {
    const live = await (await getTemporalClient()).workflow.getHandle(bookingId).query(bookingStatusQuery);
    return { ...row, status: live.status, position: live.position };
  } catch {
    return row;
  }
}

export async function cancelBooking(bookingId: string) {
  await (await getTemporalClient()).workflow.getHandle(bookingId).signal(bookingCancelSignal);
  return { ok: true };
}
export async function checkIn(bookingId: string) {
  await (await getTemporalClient()).workflow.getHandle(bookingId).signal(bookingCheckInSignal);
  return { ok: true };
}

// ------------------------------------------------------------------ support

export async function openSupportCase(input: {
  tenantId: string;
  customerId: string | null;
  orderId?: string | null;
  message: string;
  channel: string;
  timings?: { approvalSlaMs?: number; csatDelayMs?: number; csatWaitMs?: number };
}) {
  if (input.orderId) {
    const o = await repo.getOrder(input.orderId);
    if (!o) throw new ServiceError(404, 'not_found', 'Order not found');
    if (input.customerId && o.customerId !== input.customerId) throw new ServiceError(403, 'forbidden', 'That order belongs to someone else');
  }
  const caseId = repo.newId('case');
  const customerId = input.customerId ?? (input.orderId ? (await repo.getOrder(input.orderId))?.customerId ?? null : null);
  await repo.createSupportCase({ id: caseId, tenantId: input.tenantId, customerId, orderId: input.orderId, channel: input.channel, summary: input.message });
  const client = await getTemporalClient();
  const handle = await client.workflow.start('supportCaseWorkflow', {
    workflowId: caseId,
    taskQueue: OPS_QUEUE,
    args: [{ caseId, customerId, orderId: input.orderId ?? null, message: input.message, ...input.timings }],
  });
  for (let i = 0; i < 50; i++) {
    const v = await handle.query(caseStatusQuery).catch(() => null);
    if (v && v.status !== 'open' && v.status !== 'triaged') return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return handle.query(caseStatusQuery);
}

export async function supportCase(caseId: string) {
  const row = await repo.getSupportCase(caseId);
  if (!row) throw new ServiceError(404, 'not_found', 'Case not found');
  try {
    const live = await (await getTemporalClient()).workflow.getHandle(caseId).query(caseStatusQuery);
    return { ...row, live };
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return { ...row, live: null };
    return { ...row, live: null };
  }
}

export async function caseDecision(caseId: string, d: { approve: boolean; amountCents?: number; note?: string }) {
  await (await getTemporalClient()).workflow.getHandle(caseId).signal(caseDecisionSignal, d);
  return { ok: true };
}
export async function caseCsat(caseId: string, score: number) {
  await (await getTemporalClient()).workflow.getHandle(caseId).signal(caseCsatSignal, { score });
  return { ok: true };
}
export async function caseMessage(caseId: string, body: string) {
  await (await getTemporalClient()).workflow.getHandle(caseId).signal(caseCustomerMessageSignal, { body });
  return { ok: true };
}

// ------------------------------------------------------------------ ads

export async function serveAd(tenantId: string, lat?: number, lng?: number) {
  const tenants = tenantId === 'nearby' ? (await repo.listTenants()).map((t) => t.id) : [tenantId];
  const ads = await repo.eligibleAds(tenants, lat, lng);
  const ad = thompsonPick(ads);
  if (!ad) return null;
  await repo.countAdEvent(ad.id, 'impressions');
  return ad;
}
export async function clickAd(adId: string) {
  await repo.countAdEvent(adId, 'clicks');
  const ad = (await repo.listAds()).find((a) => a.id === adId);
  if (!ad) throw new ServiceError(404, 'not_found', 'Ad not found');
  return { ok: true, sourceKey: ad.sourceKey, providerId: ad.providerId };
}
