import { createHash, randomBytes } from 'node:crypto';
import type {
  Campaign,
  GeoPoint,
  MenuItem,
  NearbyPizzeria,
  OrderStatus,
  Pizzeria,
  Quote,
} from '@slice/shared';
import { boundingBox, estimateEtaMinutes, type Rollout } from '@slice/shared';
import type { PoolClient } from 'pg';
import { getPool, phonePepper, piiKey, withTx } from './pool';

type Queryable = Pick<PoolClient, 'query'>;
const db = (): Queryable => getPool();

// ---------------------------------------------------------------- mapping

const pizzeriaCols = `p.id, p.brand_id, b.name AS brand_name, p.name, p.region, p.address, p.lat, p.lng,
  p.delivery_mode, p.capacity_per_15min, p.status`;

function toPizzeria(r: any): Pizzeria {
  return {
    id: r.id,
    brandId: r.brand_id,
    brandName: r.brand_name,
    name: r.name,
    region: r.region,
    address: r.address,
    lat: r.lat,
    lng: r.lng,
    deliveryMode: r.delivery_mode,
    capacityPer15Min: r.capacity_per_15min,
    status: r.status,
  };
}

function toMenuItem(r: any): MenuItem {
  return {
    sku: r.sku,
    name: r.name,
    description: r.description,
    category: r.category,
    basePriceCents: r.base_price_cents,
    tags: r.tags,
  };
}

function toCampaign(r: any): Campaign {
  return {
    code: r.code,
    name: r.name,
    percentOff: Number(r.percent_off),
    startsAt: new Date(r.starts_at).toISOString(),
    endsAt: new Date(r.ends_at).toISOString(),
    regions: r.regions,
    skus: r.skus,
  };
}

export function newOrderId(): string {
  return `ord_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------- pizzerias & routing

const ACTIVE = `('routed','payment_authorized','accepted','preparing','ready')`;

/**
 * Nearest open pizzerias with live load. Bounding box hits the (lat,lng) index, then exact
 * haversine ranks the survivors. Fine to ~100k rows per region; PostGIS/H3 is the swap-in beyond.
 */
export async function findNearestPizzerias(
  point: GeoPoint,
  opts: { limit?: number; radiusKm?: number; excludeIds?: string[]; onlyOpen?: boolean } = {},
): Promise<NearbyPizzeria[]> {
  const radiusKm = opts.radiusKm ?? 8;
  const box = boundingBox(point, radiusKm);
  const { rows } = await db().query(
    `SELECT * FROM (
       SELECT ${pizzeriaCols},
         2 * 6371.0088 * asin(least(1, sqrt(
           power(sin(radians(p.lat - $1) / 2), 2) +
           cos(radians($1)) * cos(radians(p.lat)) * power(sin(radians(p.lng - $2) / 2), 2)
         ))) AS distance_km,
         (SELECT count(*)::int FROM orders o WHERE o.pizzeria_id = p.id AND o.status IN ${ACTIVE}) AS active_orders
       FROM pizzerias p JOIN brands b ON b.id = p.brand_id
       WHERE p.lat BETWEEN $3 AND $4 AND p.lng BETWEEN $5 AND $6
         AND ($8::boolean IS FALSE OR p.status = 'open')
         AND NOT (p.id = ANY($9::text[]))
     ) s
     WHERE distance_km <= $7
     ORDER BY distance_km
     LIMIT $10`,
    [
      point.lat,
      point.lng,
      box.minLat,
      box.maxLat,
      box.minLng,
      box.maxLng,
      radiusKm,
      opts.onlyOpen ?? true,
      opts.excludeIds ?? [],
      opts.limit ?? 5,
    ],
  );
  return rows.map((r) => ({
    ...toPizzeria(r),
    distanceKm: Math.round(r.distance_km * 100) / 100,
    activeOrders: r.active_orders,
    etaMinutes: estimateEtaMinutes(r.distance_km, r.active_orders, r.capacity_per_15min),
  }));
}

/**
 * Atomically claim a kitchen slot: lock the pizzeria row, re-count active orders, assign if under
 * capacity. Prevents two concurrent workflows from overbooking the same kitchen.
 */
export async function claimPizzeria(orderId: string, pizzeriaId: string): Promise<boolean> {
  return withTx(async (c) => {
    const p = await c.query(`SELECT capacity_per_15min, status FROM pizzerias WHERE id = $1 FOR UPDATE`, [pizzeriaId]);
    const row = p.rows[0];
    if (!row || row.status !== 'open') return false;
    const active = await c.query(
      `SELECT count(*)::int AS n FROM orders WHERE pizzeria_id = $1 AND status IN ${ACTIVE} AND id <> $2`,
      [pizzeriaId, orderId],
    );
    if (active.rows[0].n >= row.capacity_per_15min) return false;
    await c.query(`UPDATE orders SET pizzeria_id = $2, status = 'routed', updated_at = now() WHERE id = $1`, [
      orderId,
      pizzeriaId,
    ]);
    return true;
  });
}

export async function listPizzerias(filter: { region?: string; limit?: number; offset?: number } = {}) {
  const { rows } = await db().query(
    `SELECT ${pizzeriaCols} FROM pizzerias p JOIN brands b ON b.id = p.brand_id
     WHERE ($1::text IS NULL OR p.region = $1) ORDER BY p.id LIMIT $2 OFFSET $3`,
    [filter.region ?? null, filter.limit ?? 100, filter.offset ?? 0],
  );
  return rows.map(toPizzeria);
}

export async function getPizzeria(id: string): Promise<Pizzeria | null> {
  const { rows } = await db().query(
    `SELECT ${pizzeriaCols} FROM pizzerias p JOIN brands b ON b.id = p.brand_id WHERE p.id = $1`,
    [id],
  );
  return rows[0] ? toPizzeria(rows[0]) : null;
}

export async function upsertPizzeria(id: string, p: Omit<Pizzeria, 'id' | 'brandName'>): Promise<Pizzeria> {
  await db().query(
    `INSERT INTO pizzerias (id, brand_id, name, region, address, lat, lng, delivery_mode, capacity_per_15min, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET brand_id=$2, name=$3, region=$4, address=$5, lat=$6, lng=$7,
       delivery_mode=$8, capacity_per_15min=$9, status=$10, updated_at=now()`,
    [id, p.brandId, p.name, p.region, p.address, p.lat, p.lng, p.deliveryMode, p.capacityPer15Min, p.status],
  );
  return (await getPizzeria(id))!;
}

/** Soft delete: closed pizzerias keep their order history. */
export async function closePizzeria(id: string): Promise<boolean> {
  const r = await db().query(`UPDATE pizzerias SET status='closed', updated_at=now() WHERE id=$1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function listBrands() {
  const { rows } = await db().query(
    `SELECT id, name, kind, tagline, accent_color AS "accentColor" FROM brands ORDER BY name`,
  );
  return rows;
}

// ---------------------------------------------------------------- menu, campaigns, flags

export async function getMenu(pizzeriaId?: string): Promise<{ items: MenuItem[]; overrides: Record<string, number> }> {
  if (!pizzeriaId) {
    const { rows } = await db().query(`SELECT * FROM menu_items WHERE active ORDER BY category, name`);
    return { items: rows.map(toMenuItem), overrides: {} };
  }
  const { rows } = await db().query(
    `SELECT m.*, pm.price_override_cents FROM menu_items m
     LEFT JOIN pizzeria_menu pm ON pm.sku = m.sku AND pm.pizzeria_id = $1
     WHERE m.active AND coalesce(pm.available, true)
     ORDER BY m.category, m.name`,
    [pizzeriaId],
  );
  const overrides: Record<string, number> = {};
  for (const r of rows) if (r.price_override_cents != null) overrides[r.sku] = r.price_override_cents;
  return { items: rows.map(toMenuItem), overrides };
}

export async function upsertMenuItem(m: MenuItem): Promise<void> {
  await db().query(
    `INSERT INTO menu_items (sku, name, description, category, base_price_cents, tags)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (sku) DO UPDATE SET name=$2, description=$3, category=$4, base_price_cents=$5, tags=$6, active=true`,
    [m.sku, m.name, m.description, m.category, m.basePriceCents, m.tags],
  );
}

export async function deactivateMenuItem(sku: string): Promise<boolean> {
  const r = await db().query(`UPDATE menu_items SET active=false WHERE sku=$1`, [sku]);
  return (r.rowCount ?? 0) > 0;
}

export async function listCampaigns(activeAt?: Date): Promise<Campaign[]> {
  const { rows } = activeAt
    ? await db().query(`SELECT * FROM campaigns WHERE starts_at <= $1 AND ends_at > $1 ORDER BY starts_at`, [activeAt])
    : await db().query(`SELECT * FROM campaigns ORDER BY starts_at`);
  return rows.map(toCampaign);
}

export async function upsertCampaign(c: Campaign): Promise<void> {
  await db().query(
    `INSERT INTO campaigns (code, name, percent_off, starts_at, ends_at, regions, skus)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (code) DO UPDATE SET name=$2, percent_off=$3, starts_at=$4, ends_at=$5, regions=$6, skus=$7`,
    [c.code, c.name, c.percentOff, c.startsAt, c.endsAt, c.regions, c.skus],
  );
}

export async function deleteCampaign(code: string): Promise<boolean> {
  const r = await db().query(`DELETE FROM campaigns WHERE code=$1`, [code]);
  return (r.rowCount ?? 0) > 0;
}

export async function getFlag(key: string): Promise<Rollout | undefined> {
  const { rows } = await db().query(`SELECT rollout FROM feature_flags WHERE key = $1`, [key]);
  return rows[0] ? { key, ...rows[0].rollout } : undefined;
}

export async function listFlags(): Promise<Rollout[]> {
  const { rows } = await db().query(`SELECT key, rollout FROM feature_flags ORDER BY key`);
  return rows.map((r) => ({ key: r.key, ...r.rollout }));
}

export async function setFlag(key: string, rollout: Omit<Rollout, 'key'>): Promise<void> {
  await db().query(
    `INSERT INTO feature_flags (key, rollout) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET rollout=$2, updated_at=now()`,
    [key, rollout],
  );
}

// ---------------------------------------------------------------- customers (PII isolated + encrypted)

export function phoneHash(phone: string): string {
  const normalized = phone.replace(/[^\d+]/g, '');
  return createHash('sha256').update(phonePepper() + normalized).digest('hex');
}

export async function upsertCustomer(input: {
  name: string;
  phone: string;
  email?: string;
  region: string;
  marketingConsent?: boolean;
  address?: { line: string; lat: number; lng: number };
}): Promise<string> {
  const key = piiKey();
  return withTx(async (c) => {
    const hash = phoneHash(input.phone);
    const existing = await c.query(`SELECT id FROM customers WHERE phone_hash = $1`, [hash]);
    let id: string = existing.rows[0]?.id;
    if (!id) {
      const ins = await c.query(`INSERT INTO customers (region, phone_hash) VALUES ($1,$2) RETURNING id`, [
        input.region,
        hash,
      ]);
      id = ins.rows[0].id;
    }
    await c.query(
      `INSERT INTO customer_pii (customer_id, name_enc, phone_enc, email_enc)
       VALUES ($1, pgp_sym_encrypt($2,$5), pgp_sym_encrypt($3,$5), CASE WHEN $4::text IS NULL THEN NULL ELSE pgp_sym_encrypt($4,$5) END)
       ON CONFLICT (customer_id) DO UPDATE SET name_enc=EXCLUDED.name_enc, phone_enc=EXCLUDED.phone_enc,
         email_enc=coalesce(EXCLUDED.email_enc, customer_pii.email_enc)`,
      [id, input.name, input.phone, input.email ?? null, key],
    );
    if (input.address) {
      await c.query(
        `INSERT INTO customer_addresses (customer_id, line_enc, lat, lng) VALUES ($1, pgp_sym_encrypt($2,$5), $3, $4)`,
        [id, input.address.line, input.address.lat, input.address.lng, key],
      );
    }
    if (input.marketingConsent !== undefined) {
      await c.query(
        `INSERT INTO consents (customer_id, purpose, granted) VALUES ($1,'marketing',$2)
         ON CONFLICT (customer_id, purpose) DO UPDATE SET granted=$2, at=now()`,
        [id, input.marketingConsent],
      );
    }
    return id;
  });
}

/** GDPR Art. 15/20 — everything we hold about a customer, decrypted, machine-readable. */
export async function exportCustomer(customerId: string) {
  const key = piiKey();
  const pii = await db().query(
    `SELECT c.id, c.region, c.created_at, c.erased_at,
       pgp_sym_decrypt(p.name_enc, $2) AS name, pgp_sym_decrypt(p.phone_enc, $2) AS phone,
       CASE WHEN p.email_enc IS NULL THEN NULL ELSE pgp_sym_decrypt(p.email_enc, $2) END AS email
     FROM customers c LEFT JOIN customer_pii p ON p.customer_id = c.id WHERE c.id = $1`,
    [customerId, key],
  );
  if (!pii.rows[0]) return null;
  const addresses = await db().query(
    `SELECT pgp_sym_decrypt(line_enc, $2) AS line, lat, lng, created_at FROM customer_addresses WHERE customer_id=$1`,
    [customerId, key],
  );
  const consents = await db().query(`SELECT purpose, granted, at FROM consents WHERE customer_id=$1`, [customerId]);
  const orders = await db().query(
    `SELECT id, status, total_cents, items, created_at FROM orders WHERE customer_id=$1 ORDER BY created_at`,
    [customerId],
  );
  return { customer: pii.rows[0], addresses: addresses.rows, consents: consents.rows, orders: orders.rows };
}

/** GDPR Art. 17 — erase PII; orders stay as pseudonymous records for accounting. */
export async function eraseCustomer(customerId: string, actor: string): Promise<boolean> {
  return withTx(async (c) => {
    const r = await c.query(`UPDATE customers SET erased_at=now(), phone_hash=NULL WHERE id=$1 AND erased_at IS NULL`, [
      customerId,
    ]);
    if (!r.rowCount) return false;
    await c.query(`DELETE FROM customer_pii WHERE customer_id=$1`, [customerId]);
    await c.query(`DELETE FROM customer_addresses WHERE customer_id=$1`, [customerId]);
    await c.query(`DELETE FROM consents WHERE customer_id=$1`, [customerId]);
    await c.query(`UPDATE orders SET delivery_lat=round(delivery_lat::numeric,2), delivery_lng=round(delivery_lng::numeric,2) WHERE customer_id=$1`, [customerId]);
    await c.query(`INSERT INTO audit_log (actor, action, target) VALUES ($1,'erase_customer',$2)`, [actor, customerId]);
    return true;
  });
}

// ---------------------------------------------------------------- orders

export interface OrderRow {
  id: string;
  customerId: string;
  pizzeriaId: string | null;
  region: string;
  channel: string;
  status: OrderStatus;
  items: unknown;
  quote: Quote | null;
  totalCents: number | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

function toOrder(r: any): OrderRow {
  return {
    id: r.id,
    customerId: r.customer_id,
    pizzeriaId: r.pizzeria_id,
    region: r.region,
    channel: r.channel,
    status: r.status,
    items: r.items,
    quote: r.quote,
    totalCents: r.total_cents,
    failureReason: r.failure_reason,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function createOrder(o: {
  id: string;
  customerId: string;
  region: string;
  channel: string;
  items: unknown;
  deliveryLat: number;
  deliveryLng: number;
}): Promise<void> {
  await db().query(
    `INSERT INTO orders (id, customer_id, region, channel, status, items, delivery_lat, delivery_lng)
     VALUES ($1,$2,$3,$4,'received',$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
    [o.id, o.customerId, o.region, o.channel, JSON.stringify(o.items), o.deliveryLat, o.deliveryLng],
  );
  await addOrderEvent(o.id, 'received', { channel: o.channel });
}

export async function getOrder(id: string): Promise<OrderRow | null> {
  const { rows } = await db().query(`SELECT * FROM orders WHERE id=$1`, [id]);
  return rows[0] ? toOrder(rows[0]) : null;
}

export async function listOrders(filter: { status?: string; pizzeriaId?: string; limit?: number } = {}) {
  const { rows } = await db().query(
    `SELECT * FROM orders WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR pizzeria_id=$2)
     ORDER BY created_at DESC LIMIT $3`,
    [filter.status ?? null, filter.pizzeriaId ?? null, filter.limit ?? 50],
  );
  return rows.map(toOrder);
}

export async function getOrderDeliveryPoint(id: string): Promise<{ lat: number; lng: number; customerId: string; region: string } | null> {
  const { rows } = await db().query(
    `SELECT delivery_lat AS lat, delivery_lng AS lng, customer_id AS "customerId", region FROM orders WHERE id=$1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Idempotent status transition + event append (activities may be retried). */
export async function setOrderStatus(
  id: string,
  status: OrderStatus,
  event: { type: string; payload?: Record<string, unknown>; dedupeKey?: string },
  patch: { quote?: Quote; failureReason?: string; pizzeriaId?: string | null } = {},
): Promise<void> {
  await withTx(async (c) => {
    await c.query(
      `UPDATE orders SET status=$2, updated_at=now(),
         quote=coalesce($3::jsonb, quote),
         total_cents=coalesce(($3::jsonb->>'totalCents')::int, total_cents),
         campaign_code=coalesce($3::jsonb->>'campaignCode', campaign_code),
         experiment_variant=coalesce($3::jsonb->>'experimentVariant', experiment_variant),
         failure_reason=coalesce($4, failure_reason),
         pizzeria_id=CASE WHEN $5::boolean THEN $6 ELSE pizzeria_id END
       WHERE id=$1`,
      [
        id,
        status,
        patch.quote ? JSON.stringify(patch.quote) : null,
        patch.failureReason ?? null,
        patch.pizzeriaId !== undefined,
        patch.pizzeriaId ?? null,
      ],
    );
    const payload = { ...(event.payload ?? {}), ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}) };
    if (event.dedupeKey) {
      const dup = await c.query(`SELECT 1 FROM order_events WHERE order_id=$1 AND payload->>'dedupeKey'=$2`, [
        id,
        event.dedupeKey,
      ]);
      if (dup.rowCount) return;
    }
    await c.query(`INSERT INTO order_events (order_id, type, payload) VALUES ($1,$2,$3)`, [id, event.type, payload]);
  });
}

export async function addOrderEvent(id: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  await db().query(`INSERT INTO order_events (order_id, type, payload) VALUES ($1,$2,$3)`, [id, type, payload]);
}

export async function listOrderEvents(id: string) {
  const { rows } = await db().query(`SELECT type, payload, at FROM order_events WHERE order_id=$1 ORDER BY id`, [id]);
  return rows.map((r) => ({ type: r.type, detail: r.payload, at: new Date(r.at).toISOString() }));
}

export async function upsertPayment(orderId: string, provider: string, ref: string, amount: number, status: string) {
  await db().query(
    `INSERT INTO payments (order_id, provider, provider_ref, amount_cents, status) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (order_id) DO UPDATE SET status=$5, provider_ref=$3, amount_cents=$4, updated_at=now()`,
    [orderId, provider, ref, amount, status],
  );
}

export async function upsertDelivery(orderId: string, provider: string, ref: string, status: string, eta: number | null) {
  await db().query(
    `INSERT INTO deliveries (order_id, provider, external_ref, status, eta_minutes) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (order_id) DO UPDATE SET status=$4, eta_minutes=coalesce($5, deliveries.eta_minutes), updated_at=now()`,
    [orderId, provider, ref, status, eta],
  );
}

export async function getDeliveryByRef(provider: string, ref: string): Promise<{ orderId: string } | null> {
  const { rows } = await db().query(`SELECT order_id AS "orderId" FROM deliveries WHERE provider=$1 AND external_ref=$2`, [
    provider,
    ref,
  ]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- notifications, signals, ops

export async function logNotification(n: {
  orderId?: string;
  pizzeriaId?: string;
  channel: string;
  recipient: string;
  message: string;
}): Promise<void> {
  await db().query(
    `INSERT INTO notifications (order_id, pizzeria_id, channel, recipient, message) VALUES ($1,$2,$3,$4,$5)`,
    [n.orderId ?? null, n.pizzeriaId ?? null, n.channel, n.recipient, n.message],
  );
}

export async function recordProductSignal(source: string, kind: string, detail: Record<string, unknown>) {
  await db().query(`INSERT INTO product_signals (source, kind, detail) VALUES ($1,$2,$3)`, [source, kind, detail]);
}

export async function untriagedSignals(limit = 200) {
  const { rows } = await db().query(
    `SELECT id, source, kind, detail, at FROM product_signals WHERE triaged_at IS NULL ORDER BY id LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function markSignalsTriaged(ids: number[]) {
  if (ids.length) await db().query(`UPDATE product_signals SET triaged_at=now() WHERE id = ANY($1::bigint[])`, [ids]);
}

/** Per-pizzeria KPIs for the weekly ops review. */
export async function pizzeriaKpis(since: Date) {
  const { rows } = await db().query(
    `SELECT p.id, p.name, p.region, p.capacity_per_15min,
       count(o.*)::int AS orders,
       count(o.*) FILTER (WHERE o.status='delivered')::int AS delivered,
       count(o.*) FILTER (WHERE o.status IN ('failed','cancelled'))::int AS lost,
       coalesce(sum(o.total_cents) FILTER (WHERE o.status='delivered'),0)::int AS revenue_cents,
       (SELECT count(*)::int FROM order_events e JOIN orders o2 ON o2.id=e.order_id
          WHERE e.type='rerouted' AND e.payload->>'from' = p.id AND e.at >= $1) AS rerouted_away
     FROM pizzerias p LEFT JOIN orders o ON o.pizzeria_id=p.id AND o.created_at >= $1
     WHERE p.status <> 'closed'
     GROUP BY p.id ORDER BY p.id`,
    [since],
  );
  return rows;
}

export async function inventoryBelowThreshold() {
  const { rows } = await db().query(
    `SELECT pizzeria_id AS "pizzeriaId", ingredient, qty::float, unit, reorder_threshold::float AS threshold, reorder_qty::float AS "reorderQty"
     FROM inventory WHERE qty < reorder_threshold ORDER BY pizzeria_id, ingredient`,
  );
  return rows;
}

export async function restock(pizzeriaId: string, ingredient: string, qty: number) {
  await db().query(`UPDATE inventory SET qty = qty + $3 WHERE pizzeria_id=$1 AND ingredient=$2`, [
    pizzeriaId,
    ingredient,
    qty,
  ]);
}

export async function consumeInventoryForOrder(pizzeriaId: string, pizzaCount: number) {
  // Simplified bill of materials: one dough ball + 0.12 kg cheese per pizza.
  await db().query(
    `UPDATE inventory SET qty = greatest(0, qty - CASE ingredient WHEN 'dough' THEN $2::numeric WHEN 'mozzarella' THEN $2::numeric * 0.12 ELSE 0 END)
     WHERE pizzeria_id=$1`,
    [pizzeriaId, pizzaCount],
  );
}
