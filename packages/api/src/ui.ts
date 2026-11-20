import { formatEur, Surface, type A2uiServerMessage, type MenuItem, type OrderView, type Theme } from '@slice/shared';

/**
 * A2UI views. Each provider's theme rides along with its surface, so the same agent answer looks
 * like the pizzeria, the gym or the sneaker shop it comes from — or neutral when unbranded.
 */

const NEUTRAL: Theme = { mood: 'neutral' };

export interface OfferForUi {
  id: string;
  vertical: string;
  providerName: string;
  headline: string;
  priceCents: number;
  listPriceCents: number;
  etaMinutes: number | null;
  distanceM: number;
  specialTitle: string | null;
  theme: Theme;
  round: number;
}

export function offersUi(requestId: string, offers: OfferForUi[]): A2uiServerMessage[] {
  // One surface per offer so each can carry its provider's theme.
  return offers.slice(0, 5).flatMap((o, i) => {
    const s = new Surface(`offer_${requestId}_${i}`, o.theme ?? NEUTRAL);
    const name = s.text('name', o.providerName, 'h3');
    const what = s.text('what', o.headline);
    const priceLine =
      o.priceCents < o.listPriceCents ? `${formatEur(o.priceCents)} (was ${formatEur(o.listPriceCents)})` : formatEur(o.priceCents);
    const price = s.text('price', priceLine, 'h2');
    const meta = s.text(
      'meta',
      [
        o.vertical === 'food' && o.etaMinutes != null ? `~${o.etaMinutes} min to you` : null,
        o.vertical === 'fitness' && o.etaMinutes != null ? `starts in ${o.etaMinutes} min` : null,
        o.distanceM < 1000 ? `${o.distanceM} m away` : `${(o.distanceM / 1000).toFixed(1)} km away`,
        o.round > 1 ? 'counter-offer' : null,
      ]
        .filter(Boolean)
        .join(', '),
      'caption',
    );
    const kids = [name, what, price, meta];
    if (o.specialTitle) kids.push(s.text('special', o.specialTitle, 'caption'));
    kids.push(s.button('choose', o.vertical === 'food' ? 'Order this' : o.vertical === 'fitness' ? 'Book this' : 'Claim offer', 'choose_offer', { offerId: o.id }));
    const card = s.card('card', s.column('body', kids));
    return s.build([card]);
  });
}

export function menuUi(items: MenuItem[], theme?: Theme): A2uiServerMessage[] {
  const s = new Surface('menu', theme ?? NEUTRAL);
  const rows = items.slice(0, 10).map((m) =>
    s.row(`row_${m.sku}`, [s.text(`n_${m.sku}`, m.name), s.text(`p_${m.sku}`, formatEur(m.basePriceCents), 'caption')]),
  );
  return s.build([s.text('title', 'Menu', 'h3'), ...rows]);
}

export function trackerUi(v: OrderView, theme?: Theme): A2uiServerMessage[] {
  const s = new Surface(`track_${v.orderId}`, theme ?? NEUTRAL);
  const kids = [
    s.text('title', `${v.brandName ?? 'Your order'}: ${v.status.replace(/_/g, ' ')}`, 'h3'),
    s.text('kitchen', v.pizzeriaName ?? 'Choosing a kitchen…', 'caption'),
  ];
  if (v.tracking) kids.push(s.text('live', `Courier ${v.tracking.remainingKm} km away, about ${v.tracking.etaMinutes} min`));
  if (!['out_for_delivery', 'delivered', 'cancelled', 'failed'].includes(v.status)) {
    kids.push(s.button('cancel', 'Cancel order', 'cancel_order', { orderId: v.orderId }, 'borderless'));
  }
  kids.push(s.button('help', 'Get help', 'open_support_case', { orderId: v.orderId, message: 'I need help with my order' }, 'borderless'));
  return s.build([s.card('card', s.column('body', kids))]);
}

export function classesUi(classes: Array<{ id: string; title: string; gymName: string; startsAt: string; spotsLeft: number; priceCents: number; theme: Theme }>): A2uiServerMessage[] {
  return classes.slice(0, 5).flatMap((c, i) => {
    const s = new Surface(`class_${i}_${c.id}`, c.theme);
    const kids = [
      s.text('title', c.title, 'h3'),
      s.text('where', `${c.gymName}, ${c.startsAt.slice(11, 16)} UTC`, 'caption'),
      s.text('price', `${formatEur(c.priceCents)}, ${c.spotsLeft ? `${c.spotsLeft} spots left` : 'waitlist'}`),
      s.button('book', c.spotsLeft ? 'Book' : 'Join waitlist', 'book_class', { classId: c.id }),
    ];
    return s.build([s.card('card', s.column('body', kids))]);
  });
}

export function caseUi(c: { caseId: string; status: string; category: string | null; amountCents: number; replies: string[] }): A2uiServerMessage[] {
  const s = new Surface(`case_${c.caseId}`, NEUTRAL);
  const kids = [
    s.text('title', `Support case: ${c.status.replace(/_/g, ' ')}`, 'h3'),
    s.text('reply', c.replies.at(-1) ?? 'We are on it.'),
  ];
  if (c.amountCents) kids.push(s.text('amount', `Compensation: ${formatEur(c.amountCents)}`, 'caption'));
  if (c.status === 'resolved' || c.status === 'closed') {
    kids.push(s.row('rate', [1, 2, 3, 4, 5].map((n) => s.button(`rate_${n}`, String(n), 'rate_support', { caseId: c.caseId, score: n }, 'borderless')), 'start'));
  }
  return s.build([s.card('card', s.column('body', kids))]);
}

export function voucherUi(v: { code: string; merchantName: string; headline: string; priceCents: number; expiresAt: string; place: string | null }, theme: Theme): A2uiServerMessage[] {
  const s = new Surface(`voucher_${v.code}`, theme);
  const kids = [
    s.text('merchant', v.merchantName, 'h3'),
    s.text('what', `${v.headline} for ${formatEur(v.priceCents)}`),
    s.text('code', v.code, 'h1'),
    s.text('how', `Show this code at the till${v.place ? ` (${v.place})` : ''}. Valid until ${v.expiresAt.slice(11, 16)} UTC.`, 'caption'),
  ];
  return s.build([s.card('card', s.column('body', kids))]);
}

export function adUi(ad: { id: string; headline: string; body: string; cta: string; theme: Theme }): A2uiServerMessage[] {
  const s = new Surface(`ad_${ad.id}`, ad.theme);
  const kids = [s.text('headline', ad.headline, 'h3'), s.text('body', ad.body, 'caption'), s.button('cta', ad.cta, 'ad_click', { adId: ad.id })];
  return s.build([s.card('card', s.column('body', kids))]);
}
