import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { OfferDraft, RankedOffer, SpecialRule, Theme } from '@slice/shared';
import { boundingBox } from '@slice/shared';
import { getPool, piiKey, withTx } from './pool';
import { phoneHash } from './repo';

const db = () => getPool();
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- tenants

export interface Tenant {
  id: string;
  name: string;
  verticals: string[];
  branding: Theme | null;
}
export async function getTenant(id: string): Promise<Tenant | null> {
  const { rows } = await db().query(`SELECT id, name, verticals, branding FROM tenants WHERE id=$1`, [id]);
  return rows[0] ?? null;
}
export async function listTenants(): Promise<Tenant[]> {
  return (await db().query(`SELECT id, name, verticals, branding FROM tenants ORDER BY id`)).rows;
}

// ---------------------------------------------------------------- customer contact (decrypt only when needed)

export async function getCustomerContact(customerId: string): Promise<{ name: string; phone: string; region: string } | null> {
  const { rows } = await db().query(
    `SELECT pgp_sym_decrypt(p.name_enc, $2) AS name, pgp_sym_decrypt(p.phone_enc, $2) AS phone, c.region
     FROM customers c JOIN customer_pii p ON p.customer_id = c.id WHERE c.id = $1 AND c.erased_at IS NULL`,
    [customerId, piiKey()],
  );
  return rows[0] ?? null;
}
export async function findCustomerByPhone(phone: string): Promise<string | null> {
  const { rows } = await db().query(`SELECT id FROM customers WHERE phone_hash=$1 AND erased_at IS NULL`, [phoneHash(phone)]);
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------- identity: OTP + tokens

export async function startOtp(phone: string): Promise<string> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db().query(
    `INSERT INTO auth_codes (phone_hash, code_hash, attempts, expires_at) VALUES ($1,$2,0, now() + interval '10 minutes')
     ON CONFLICT (phone_hash) DO UPDATE SET code_hash=$2, attempts=0, expires_at=now() + interval '10 minutes'`,
    [phoneHash(phone), sha(code)],
  );
  return code;
}

export async function verifyOtp(phone: string, code: string): Promise<boolean> {
  return withTx(async (c) => {
    const { rows } = await c.query(`SELECT code_hash, attempts, expires_at FROM auth_codes WHERE phone_hash=$1 FOR UPDATE`, [phoneHash(phone)]);
    const r = rows[0];
    if (!r || r.attempts >= 5 || new Date(r.expires_at) < new Date()) return false;
    if (r.code_hash !== sha(code)) {
      await c.query(`UPDATE auth_codes SET attempts = attempts + 1 WHERE phone_hash=$1`, [phoneHash(phone)]);
      return false;
    }
    await c.query(`DELETE FROM auth_codes WHERE phone_hash=$1`, [phoneHash(phone)]);
    return true;
  });
}

export async function ensureCustomerForPhone(phone: string, region = 'unknown'): Promise<string> {
  const existing = await findCustomerByPhone(phone);
  if (existing) return existing;
  const { rows } = await db().query(`INSERT INTO customers (region, phone_hash) VALUES ($1,$2) RETURNING id`, [region, phoneHash(phone)]);
  await db().query(
    `INSERT INTO customer_pii (customer_id, name_enc, phone_enc) VALUES ($1, pgp_sym_encrypt('', $3), pgp_sym_encrypt($2, $3))`,
    [rows[0].id, phone, piiKey()],
  );
  return rows[0].id;
}

export async function issueToken(customerId: string, kind: 'session' | 'assistant', label: string, scopes: string[]) {
  const token = `${kind === 'session' ? 'sk_sess' : 'sk_asst'}_${randomBytes(24).toString('base64url')}`;
  const id = newId('tok');
  await db().query(
    `INSERT INTO customer_tokens (id, token_hash, customer_id, kind, label, scopes) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, sha(token), customerId, kind, label, scopes],
  );
  return { id, token };
}

export async function resolveToken(token: string): Promise<{ id: string; customerId: string; kind: string; scopes: string[]; label: string } | null> {
  const { rows } = await db().query(
    `UPDATE customer_tokens SET last_used_at=now() WHERE token_hash=$1 AND revoked_at IS NULL
     RETURNING id, customer_id AS "customerId", kind, scopes, label`,
    [sha(token)],
  );
  return rows[0] ?? null;
}

export async function listAssistantTokens(customerId: string) {
  const { rows } = await db().query(
    `SELECT id, label, scopes, created_at AS "createdAt", last_used_at AS "lastUsedAt" FROM customer_tokens
     WHERE customer_id=$1 AND kind='assistant' AND revoked_at IS NULL ORDER BY created_at`,
    [customerId],
  );
  return rows;
}

export async function revokeToken(customerId: string, id: string): Promise<boolean> {
  const r = await db().query(`UPDATE customer_tokens SET revoked_at=now() WHERE id=$1 AND customer_id=$2 AND revoked_at IS NULL`, [id, customerId]);
  return (r.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------- specials

function toSpecial(r: any): SpecialRule {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    value: Number(r.value),
    sku: r.sku,
    minSubtotalCents: r.min_subtotal_cents,
    startsAt: new Date(r.starts_at).toISOString(),
    endsAt: new Date(r.ends_at).toISOString(),
  };
}
export async function specialsFor(providerIds: string[], at: Date): Promise<Record<string, SpecialRule[]>> {
  const { rows } = await db().query(
    `SELECT * FROM specials WHERE active AND provider_id = ANY($1::text[]) AND starts_at <= $2 AND ends_at > $2`,
    [providerIds, at],
  );
  const out: Record<string, SpecialRule[]> = {};
  for (const r of rows) (out[r.provider_id] ??= []).push(toSpecial(r));
  return out;
}
export async function listActiveSpecials(at: Date) {
  const { rows } = await db().query(`SELECT * FROM specials WHERE active AND starts_at <= $1 AND ends_at > $1 ORDER BY id`, [at]);
  return rows.map((r) => ({ ...toSpecial(r), providerId: r.provider_id as string, tenantId: r.tenant_id as string }));
}
export async function upsertSpecial(s: SpecialRule & { tenantId: string; providerId: string }) {
  await db().query(
    `INSERT INTO specials (id, tenant_id, provider_id, title, kind, value, sku, min_subtotal_cents, starts_at, ends_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET title=$4, kind=$5, value=$6, sku=$7, min_subtotal_cents=$8, starts_at=$9, ends_at=$10, active=true`,
    [s.id, s.tenantId, s.providerId, s.title, s.kind, s.value, s.sku, s.minSubtotalCents, s.startsAt, s.endsAt],
  );
}

// ---------------------------------------------------------------- retail merchants

export interface MerchantRow {
  id: string;
  tenantId: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  place: string | null;
  theme: Theme;
  maxDiscountPct: number;
  competePolicy: 'hold' | 'match' | 'beat';
  offerAgentUrl: string | null;
}
const toMerchant = (r: any): MerchantRow => ({
  id: r.id,
  tenantId: r.tenant_id,
  name: r.name,
  category: r.category,
  lat: r.lat,
  lng: r.lng,
  place: r.place,
  theme: r.theme,
  maxDiscountPct: Number(r.max_discount_pct),
  competePolicy: r.compete_policy,
  offerAgentUrl: r.offer_agent_url,
});

export async function merchantsNear(lat: number, lng: number, radiusM: number, category?: string): Promise<MerchantRow[]> {
  const box = boundingBox({ lat, lng }, radiusM / 1000);
  const { rows } = await db().query(
    `SELECT * FROM merchants WHERE lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4 AND ($5::text IS NULL OR category=$5) ORDER BY id`,
    [box.minLat, box.maxLat, box.minLng, box.maxLng, category ?? null],
  );
  return rows.map(toMerchant);
}

export async function dealsFor(merchantIds: string[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const { rows } = await db().query(
    `SELECT * FROM merchant_deals WHERE active AND stock > 0 AND merchant_id = ANY($1::text[])`,
    [merchantIds],
  );
  return rows
    .map((r) => {
      const hay = [r.title, r.category, ...(r.keywords as string[])].join(' ').toLowerCase();
      const hits = words.filter((w) => hay.includes(w) || hay.includes(w.replace(/s$/, ''))).length;
      return {
        id: r.id as string,
        merchantId: r.merchant_id as string,
        title: r.title as string,
        category: r.category as string,
        priceCents: r.price_cents as number,
        floorPriceCents: r.floor_price_cents as number,
        stock: r.stock as number,
        hits,
      };
    })
    .filter((d) => words.length === 0 || d.hits > 0);
}

// ---------------------------------------------------------------- offers

export async function createOfferRequest(r: {
  id: string;
  tenantId: string;
  vertical: string;
  customerKey: string;
  lat: number;
  lng: number;
  request: unknown;
  preference: string;
}) {
  await db().query(
    `INSERT INTO offer_requests (id, tenant_id, vertical, customer_key, lat, lng, request, preference)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
    [r.id, r.tenantId, r.vertical, r.customerKey, r.lat, r.lng, JSON.stringify(r.request), r.preference],
  );
}

export type PublicOffer = Omit<RankedOffer, 'floorPriceCents' | 'competePolicy'> & { id: string; expiresAt: string };

export async function saveOffers(requestId: string, offers: RankedOffer[], ttlSeconds: number): Promise<PublicOffer[]> {
  const out: PublicOffer[] = [];
  await withTx(async (c) => {
    await c.query(`DELETE FROM offers WHERE request_id=$1`, [requestId]); // idempotent on retry
    for (const [i, o] of offers.entries()) {
      const id = `${requestId}_${i + 1}`;
      const r = await c.query(
        `INSERT INTO offers (id, request_id, vertical, provider_id, provider_name, round, price_cents, list_price_cents, eta_minutes,
           distance_m, headline, special_title, theme, details, score, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now() + make_interval(secs => $16)) RETURNING expires_at`,
        [id, requestId, o.vertical, o.providerId, o.providerName, o.round, o.priceCents, o.listPriceCents, o.etaMinutes, o.distanceM,
          o.headline, o.specialTitle, o.theme, o.details, o.score, ttlSeconds],
      );
      // Floors and policies are the provider's private business: never returned to customers.
      const { floorPriceCents: _f, competePolicy: _c, ...pub } = o;
      out.push({ ...pub, id, expiresAt: new Date(r.rows[0].expires_at).toISOString() });
    }
    await c.query(`UPDATE offer_requests SET status='offered' WHERE id=$1`, [requestId]);
  });
  return out;
}

export interface StoredOffer extends OfferDraft {
  id: string;
  requestId: string;
  score: number;
  status: string;
  expiresAt: string;
  customerKey: string;
  tenantId: string;
}
export async function getOffer(id: string): Promise<StoredOffer | null> {
  const { rows } = await db().query(
    `SELECT o.*, r.customer_key, r.tenant_id FROM offers o JOIN offer_requests r ON r.id = o.request_id WHERE o.id=$1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    requestId: r.request_id,
    vertical: r.vertical,
    providerId: r.provider_id,
    providerName: r.provider_name,
    listPriceCents: r.list_price_cents,
    priceCents: r.price_cents,
    etaMinutes: r.eta_minutes,
    distanceM: r.distance_m,
    headline: r.headline,
    specialTitle: r.special_title,
    theme: r.theme,
    details: r.details,
    floorPriceCents: r.price_cents,
    competePolicy: 'hold',
    round: r.round,
    score: Number(r.score),
    status: r.status,
    expiresAt: new Date(r.expires_at).toISOString(),
    customerKey: r.customer_key,
    tenantId: r.tenant_id,
  };
}

/** Marks the winner and the rest lost. Returns false if the offer is gone, expired or already decided. */
export async function acceptOffer(id: string): Promise<boolean> {
  return withTx(async (c) => {
    const { rows } = await c.query(`SELECT request_id, status, expires_at FROM offers WHERE id=$1 FOR UPDATE`, [id]);
    const r = rows[0];
    if (!r || r.status !== 'open' || new Date(r.expires_at) < new Date()) return false;
    await c.query(`UPDATE offers SET status = CASE WHEN id=$1 THEN 'won' ELSE 'lost' END WHERE request_id=$2`, [id, r.request_id]);
    await c.query(`UPDATE offer_requests SET status='accepted', chosen_offer=$1 WHERE id=$2`, [id, r.request_id]);
    return true;
  });
}

export async function issueVoucher(offerId: string, customerKey: string, ttlMinutes = 30) {
  // make_interval(mins => …) accepts fractions, so short test TTLs work too.
  const code = randomBytes(4).toString('hex').toUpperCase();
  const { rows } = await db().query(
    `INSERT INTO vouchers (code, offer_id, customer_key, expires_at) VALUES ($1,$2,$3, now() + make_interval(secs => $4::float8 * 60)) RETURNING expires_at`,
    [code, offerId, customerKey, ttlMinutes],
  );
  return { code, expiresAt: new Date(rows[0].expires_at).toISOString() };
}
export async function setVoucherStatus(code: string, status: 'redeemed' | 'expired', onlyIfIssued = true): Promise<boolean> {
  const r = await db().query(
    `UPDATE vouchers SET status=$2 WHERE code=$1 ${onlyIfIssued ? `AND status='issued'` : ''}`,
    [code, status],
  );
  return (r.rowCount ?? 0) > 0;
}
export async function getVoucher(code: string) {
  const { rows } = await db().query(
    `SELECT v.code, v.status, v.expires_at AS "expiresAt", o.provider_id AS "merchantId", o.provider_name AS "merchantName",
       o.headline, o.price_cents AS "priceCents", o.details
     FROM vouchers v JOIN offers o ON o.id = v.offer_id WHERE v.code=$1`,
    [code],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- fitness

export async function classesNear(lat: number, lng: number, opts: { kind?: string; withinHours?: number; radiusKm?: number } = {}) {
  const box = boundingBox({ lat, lng }, opts.radiusKm ?? 6);
  const { rows } = await db().query(
    `SELECT c.*, g.name AS gym_name, g.lat, g.lng, g.theme, g.tenant_id,
       (SELECT count(*)::int FROM class_bookings b WHERE b.class_id=c.id AND b.status IN ('confirmed','attended')) AS booked,
       (SELECT count(*)::int FROM class_bookings b WHERE b.class_id=c.id AND b.status='waitlisted') AS waitlisted
     FROM gym_classes c JOIN gyms g ON g.id=c.gym_id
     WHERE g.lat BETWEEN $1 AND $2 AND g.lng BETWEEN $3 AND $4
       AND c.starts_at > now() AND c.starts_at < now() + make_interval(hours => $5)
       AND ($6::text IS NULL OR c.kind = $6)
     ORDER BY c.starts_at LIMIT 50`,
    [box.minLat, box.maxLat, box.minLng, box.maxLng, opts.withinHours ?? 48, opts.kind ?? null],
  );
  return rows.map((r) => ({
    id: r.id as string,
    gymId: r.gym_id as string,
    gymName: r.gym_name as string,
    tenantId: r.tenant_id as string,
    title: r.title as string,
    kind: r.kind as string,
    startsAt: new Date(r.starts_at).toISOString(),
    durationMin: r.duration_min as number,
    capacity: r.capacity as number,
    booked: r.booked as number,
    waitlisted: r.waitlisted as number,
    spotsLeft: Math.max(0, r.capacity - r.booked),
    priceCents: r.price_cents as number,
    instructor: r.instructor as string,
    lat: r.lat as number,
    lng: r.lng as number,
    theme: r.theme as Theme,
  }));
}

export async function getClass(id: string) {
  const { rows } = await db().query(
    `SELECT c.*, g.name AS gym_name, g.tenant_id FROM gym_classes c JOIN gyms g ON g.id=c.gym_id WHERE c.id=$1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id as string,
    gymId: r.gym_id as string,
    gymName: r.gym_name as string,
    tenantId: r.tenant_id as string,
    title: r.title as string,
    startsAt: new Date(r.starts_at).toISOString(),
    durationMin: r.duration_min as number,
    capacity: r.capacity as number,
    priceCents: r.price_cents as number,
  };
}

export async function createBooking(b: { id: string; classId: string; customerId: string; priceCents: number; offerId?: string | null }) {
  await db().query(
    `INSERT INTO class_bookings (id, class_id, customer_id, status, price_cents, offer_id) VALUES ($1,$2,$3,'pending',$4,$5)
     ON CONFLICT (id) DO NOTHING`,
    [b.id, b.classId, b.customerId, b.priceCents, b.offerId ?? null],
  );
}

/** Confirm if a spot is free, else waitlist. Row lock on the class serialises concurrent bookings. */
export async function reserveSpot(bookingId: string): Promise<{ status: 'confirmed' | 'waitlisted'; position: number }> {
  return withTx(async (c) => {
    const b = await c.query(`SELECT class_id, status FROM class_bookings WHERE id=$1`, [bookingId]);
    const booking = b.rows[0];
    if (booking.status === 'confirmed') return { status: 'confirmed' as const, position: 0 };
    const cls = await c.query(`SELECT capacity FROM gym_classes WHERE id=$1 FOR UPDATE`, [booking.class_id]);
    const n = await c.query(`SELECT count(*)::int AS n FROM class_bookings WHERE class_id=$1 AND status='confirmed'`, [booking.class_id]);
    if (n.rows[0].n < cls.rows[0].capacity) {
      await c.query(`UPDATE class_bookings SET status='confirmed', updated_at=now() WHERE id=$1`, [bookingId]);
      return { status: 'confirmed' as const, position: 0 };
    }
    await c.query(`UPDATE class_bookings SET status='waitlisted', updated_at=now() WHERE id=$1`, [bookingId]);
    const pos = await c.query(
      `SELECT count(*)::int AS n FROM class_bookings WHERE class_id=$1 AND status='waitlisted' AND created_at <= (SELECT created_at FROM class_bookings WHERE id=$2)`,
      [booking.class_id, bookingId],
    );
    return { status: 'waitlisted' as const, position: pos.rows[0].n };
  });
}

export async function setBookingStatus(id: string, status: string) {
  await db().query(`UPDATE class_bookings SET status=$2, updated_at=now() WHERE id=$1`, [id, status]);
}

/** Give a freed spot to the longest-waiting person; returns their booking id. */
export async function promoteFromWaitlist(classId: string): Promise<string | null> {
  return withTx(async (c) => {
    await c.query(`SELECT 1 FROM gym_classes WHERE id=$1 FOR UPDATE`, [classId]);
    const cap = await c.query(
      `SELECT c.capacity - (SELECT count(*) FROM class_bookings WHERE class_id=$1 AND status='confirmed') AS free FROM gym_classes c WHERE c.id=$1`,
      [classId],
    );
    if (Number(cap.rows[0].free) <= 0) return null;
    const next = await c.query(
      `SELECT id FROM class_bookings WHERE class_id=$1 AND status='waitlisted' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [classId],
    );
    if (!next.rows[0]) return null;
    await c.query(`UPDATE class_bookings SET status='confirmed', updated_at=now() WHERE id=$1`, [next.rows[0].id]);
    return next.rows[0].id as string;
  });
}

export async function getBooking(id: string) {
  const { rows } = await db().query(
    `SELECT b.id, b.status, b.class_id AS "classId", b.customer_id AS "customerId", b.price_cents AS "priceCents",
       c.title, c.starts_at AS "startsAt", g.name AS "gymName"
     FROM class_bookings b JOIN gym_classes c ON c.id=b.class_id JOIN gyms g ON g.id=c.gym_id WHERE b.id=$1`,
    [id],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- agent memory

export async function ensureSession(id: string, tenantId: string, channel: string, customerId?: string | null) {
  await db().query(
    `INSERT INTO agent_sessions (id, tenant_id, channel, customer_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET updated_at=now(), customer_id=coalesce(agent_sessions.customer_id, EXCLUDED.customer_id)`,
    [id, tenantId, channel, customerId ?? null],
  );
}
export async function loadMessages(sessionId: string, limit = 20) {
  const { rows } = await db().query(
    `SELECT role, content, data FROM (SELECT * FROM agent_messages WHERE session_id=$1 ORDER BY id DESC LIMIT $2) t ORDER BY id`,
    [sessionId, limit],
  );
  return rows as Array<{ role: string; content: string; data: any }>;
}
export async function appendMessage(sessionId: string, role: string, content: string, data?: unknown) {
  await db().query(`INSERT INTO agent_messages (session_id, role, content, data) VALUES ($1,$2,$3,$4)`, [
    sessionId,
    role,
    content,
    data === undefined ? null : JSON.stringify(data),
  ]);
}
export async function savePlan(sessionId: string, plan: unknown) {
  await db().query(`UPDATE agent_sessions SET plan=$2, updated_at=now() WHERE id=$1`, [sessionId, JSON.stringify(plan)]);
}
export async function getSession(sessionId: string) {
  const { rows } = await db().query(`SELECT id, tenant_id AS "tenantId", channel, customer_id AS "customerId", plan FROM agent_sessions WHERE id=$1`, [sessionId]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- support

export async function createSupportCase(c: { id: string; tenantId: string; customerId?: string | null; orderId?: string | null; channel: string; summary: string }) {
  await db().query(
    `INSERT INTO support_cases (id, tenant_id, customer_id, order_id, channel, status, summary) VALUES ($1,$2,$3,$4,$5,'open',$6)
     ON CONFLICT (id) DO NOTHING`,
    [c.id, c.tenantId, c.customerId ?? null, c.orderId ?? null, c.channel, c.summary],
  );
  await addSupportMessage(c.id, 'customer', c.summary);
}
export async function addSupportMessage(caseId: string, author: string, body: string) {
  await db().query(`INSERT INTO support_messages (case_id, author, body) VALUES ($1,$2,$3)`, [caseId, author, body]);
}
export async function updateSupportCase(id: string, patch: { status?: string; category?: string; resolution?: string; creditCents?: number; csat?: number }) {
  await db().query(
    `UPDATE support_cases SET status=coalesce($2,status), category=coalesce($3,category), resolution=coalesce($4,resolution),
       credit_cents=coalesce($5,credit_cents), csat=coalesce($6,csat), updated_at=now() WHERE id=$1`,
    [id, patch.status ?? null, patch.category ?? null, patch.resolution ?? null, patch.creditCents ?? null, patch.csat ?? null],
  );
}
export async function getSupportCase(id: string) {
  const { rows } = await db().query(
    `SELECT id, tenant_id AS "tenantId", customer_id AS "customerId", order_id AS "orderId", channel, category, status, summary,
       resolution, credit_cents AS "creditCents", csat, created_at AS "createdAt" FROM support_cases WHERE id=$1`,
    [id],
  );
  if (!rows[0]) return null;
  const msgs = await db().query(`SELECT author, body, at FROM support_messages WHERE case_id=$1 ORDER BY id`, [id]);
  return { ...rows[0], messages: msgs.rows };
}

// ---------------------------------------------------------------- ads

export interface AdRow {
  id: string;
  tenantId: string;
  sourceKey: string;
  variant: string;
  providerId: string | null;
  headline: string;
  body: string;
  cta: string;
  lat: number | null;
  lng: number | null;
  theme: Theme;
  status: string;
  generatedBy: string;
  impressions: number;
  clicks: number;
  conversions: number;
  expiresAt: string;
}
const toAd = (r: any): AdRow => ({
  id: r.id,
  tenantId: r.tenant_id,
  sourceKey: r.source_key,
  variant: r.variant,
  providerId: r.provider_id,
  headline: r.headline,
  body: r.body,
  cta: r.cta,
  lat: r.lat,
  lng: r.lng,
  theme: r.theme,
  status: r.status,
  generatedBy: r.generated_by,
  impressions: r.impressions,
  clicks: r.clicks,
  conversions: r.conversions,
  expiresAt: new Date(r.expires_at).toISOString(),
});
export async function upsertAd(a: Omit<AdRow, 'impressions' | 'clicks' | 'conversions' | 'expiresAt'> & { expiresAt: string }) {
  const r = await db().query(
    `INSERT INTO ads (id, tenant_id, source_key, variant, provider_id, headline, body, cta, lat, lng, theme, status, generated_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (source_key, variant) DO UPDATE SET expires_at=EXCLUDED.expires_at RETURNING (xmax = 0) AS inserted`,
    [a.id, a.tenantId, a.sourceKey, a.variant, a.providerId, a.headline, a.body, a.cta, a.lat, a.lng, a.theme, a.status, a.generatedBy, a.expiresAt],
  );
  return r.rows[0].inserted as boolean;
}
export async function eligibleAds(tenantIds: string[], lat?: number, lng?: number, radiusKm = 5): Promise<AdRow[]> {
  const { rows } = await db().query(
    `SELECT * FROM ads WHERE status='active' AND expires_at > now() AND tenant_id = ANY($1::text[])
       AND ($2::float8 IS NULL OR lat IS NULL OR (abs(lat - $2) < $4 / 111.0 AND abs(lng - $3) < $4 / 68.0))`,
    [tenantIds, lat ?? null, lng ?? null, radiusKm],
  );
  return rows.map(toAd);
}
export async function listAds() {
  return (await db().query(`SELECT * FROM ads ORDER BY source_key, variant`)).rows.map(toAd);
}
export async function countAdEvent(id: string, field: 'impressions' | 'clicks' | 'conversions') {
  await db().query(`UPDATE ads SET ${field} = ${field} + 1 WHERE id=$1`, [id]);
}
export async function setAdStatus(ids: string[], status: string) {
  if (ids.length) await db().query(`UPDATE ads SET status=$2 WHERE id = ANY($1::text[])`, [ids, status]);
}
export async function expireAds() {
  await db().query(`UPDATE ads SET status='ended' WHERE status='active' AND expires_at <= now()`);
}

// ---------------------------------------------------------------- voice

export async function logVoiceCall(v: { provider: string; direction: 'inbound' | 'outbound'; conversationId?: string | null; recipient?: string | null; purpose: string; status: string; summary?: string | null }) {
  await db().query(
    `INSERT INTO voice_calls (provider, direction, conversation_id, recipient, purpose, status, summary) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [v.provider, v.direction, v.conversationId ?? null, v.recipient ?? null, v.purpose, v.status, v.summary ?? null],
  );
}

// ---------------------------------------------------------------- buttons & callbacks

export interface ButtonRow {
  id: string;
  customerId: string;
  tenantId: string;
  label: string;
  kind: 'physical' | 'app';
  actions: Record<'single' | 'double' | 'long', 'callback' | 'reorder' | 'cancel' | 'support_followup'>;
  quietFrom: number | null;
  quietTo: number | null;
  timezone: string;
}
const toButton = (r: any): ButtonRow => ({
  id: r.id,
  customerId: r.customer_id,
  tenantId: r.tenant_id,
  label: r.label,
  kind: r.kind,
  actions: r.actions,
  quietFrom: r.quiet_from,
  quietTo: r.quiet_to,
  timezone: r.timezone,
});

export async function registerButton(b: { customerId: string; tenantId: string; label: string; kind: 'physical' | 'app'; quietFrom?: number | null; quietTo?: number | null; timezone?: string }) {
  const id = newId('btn');
  const token = `sk_btn_${randomBytes(18).toString('base64url')}`;
  await db().query(
    `INSERT INTO buttons (id, token_hash, customer_id, tenant_id, label, kind, quiet_from, quiet_to, timezone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, sha(token), b.customerId, b.tenantId, b.label, b.kind, b.quietFrom ?? null, b.quietTo ?? null, b.timezone ?? 'Europe/Berlin'],
  );
  return { id, token };
}
export async function buttonByToken(id: string, token: string): Promise<ButtonRow | null> {
  const { rows } = await db().query(
    `UPDATE buttons SET last_pressed_at=now() WHERE id=$1 AND token_hash=$2 AND revoked_at IS NULL RETURNING *`,
    [id, sha(token)],
  );
  return rows[0] ? toButton(rows[0]) : null;
}
export async function listButtons(customerId: string) {
  const { rows } = await db().query(`SELECT * FROM buttons WHERE customer_id=$1 AND revoked_at IS NULL ORDER BY created_at`, [customerId]);
  return rows.map(toButton);
}
export async function revokeButton(customerId: string, id: string) {
  const r = await db().query(`UPDATE buttons SET revoked_at=now() WHERE id=$1 AND customer_id=$2 AND revoked_at IS NULL`, [id, customerId]);
  return (r.rowCount ?? 0) > 0;
}

export async function createCallback(c: { id: string; customerId: string; tenantId: string; source: string; intent: string }) {
  await db().query(
    `INSERT INTO callbacks (id, customer_id, tenant_id, source, intent, status) VALUES ($1,$2,$3,$4,$5,'requested')
     ON CONFLICT (id) DO UPDATE SET presses = callbacks.presses + 1, updated_at = now()`,
    [c.id, c.customerId, c.tenantId, c.source, c.intent],
  );
}
export async function updateCallback(id: string, patch: { status?: string; attempts?: number; scheduledFor?: string | null; conversationId?: string | null; context?: unknown; outcome?: string; presses?: number }) {
  await db().query(
    `UPDATE callbacks SET status=coalesce($2,status), attempts=coalesce($3,attempts), scheduled_for=coalesce($4,scheduled_for),
       conversation_id=coalesce($5,conversation_id), context=coalesce($6,context), outcome=coalesce($7,outcome),
       presses=coalesce($8,presses), updated_at=now() WHERE id=$1`,
    [id, patch.status ?? null, patch.attempts ?? null, patch.scheduledFor ?? null, patch.conversationId ?? null,
      patch.context === undefined ? null : JSON.stringify(patch.context), patch.outcome ?? null, patch.presses ?? null],
  );
}
export async function getCallback(id: string) {
  const { rows } = await db().query(`SELECT * FROM callbacks WHERE id=$1`, [id]);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id as string,
    customerId: r.customer_id as string,
    tenantId: r.tenant_id as string,
    source: r.source as string,
    intent: r.intent as string,
    status: r.status as string,
    presses: r.presses as number,
    attempts: r.attempts as number,
    scheduledFor: r.scheduled_for ? new Date(r.scheduled_for).toISOString() : null,
    conversationId: r.conversation_id as string | null,
    context: r.context as Record<string, any>,
    outcome: r.outcome as string | null,
  };
}
export async function callbackByConversation(conversationId: string) {
  const { rows } = await db().query(`SELECT id FROM callbacks WHERE conversation_id=$1`, [conversationId]);
  return rows[0] ? getCallback(rows[0].id) : null;
}

/** What the agent should know before it dials: last order, open issues, upcoming bookings. */
export async function customerContext(customerId: string) {
  const pool = db();
  const contact = await getCustomerContact(customerId);
  const lastOrder = (
    await pool.query(
      `SELECT o.id, o.status, o.items, o.total_cents, o.delivery_lat, o.delivery_lng, o.created_at, p.name AS pizzeria
       FROM orders o LEFT JOIN pizzerias p ON p.id=o.pizzeria_id WHERE o.customer_id=$1 ORDER BY o.created_at DESC LIMIT 1`,
      [customerId],
    )
  ).rows[0];
  const usual = (
    await pool.query(
      `SELECT items, delivery_lat, delivery_lng FROM orders WHERE customer_id=$1 AND status='delivered' ORDER BY created_at DESC LIMIT 1`,
      [customerId],
    )
  ).rows[0];
  const openCases = (
    await pool.query(`SELECT id, category, status FROM support_cases WHERE customer_id=$1 AND status NOT IN ('resolved','closed') ORDER BY created_at DESC LIMIT 3`, [customerId])
  ).rows;
  const bookings = (
    await pool.query(
      `SELECT b.id, b.status, c.title, c.starts_at FROM class_bookings b JOIN gym_classes c ON c.id=b.class_id
       WHERE b.customer_id=$1 AND c.starts_at > now() AND b.status IN ('confirmed','waitlisted') ORDER BY c.starts_at LIMIT 3`,
      [customerId],
    )
  ).rows;
  return {
    firstName: ((contact?.name || '').split(' ')[0] || null) === 'Customer' ? null : (contact?.name || '').split(' ')[0] || null,
    lastOrder: lastOrder
      ? { id: lastOrder.id, status: lastOrder.status, items: lastOrder.items, totalCents: lastOrder.total_cents, pizzeria: lastOrder.pizzeria, at: new Date(lastOrder.created_at).toISOString() }
      : null,
    usual: usual ? { items: usual.items, lat: usual.delivery_lat, lng: usual.delivery_lng } : null,
    openCases,
    upcomingBookings: bookings.map((b) => ({ id: b.id, status: b.status, title: b.title, startsAt: new Date(b.starts_at).toISOString() })),
  };
}
