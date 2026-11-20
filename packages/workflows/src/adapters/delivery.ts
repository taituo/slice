import { createHash } from 'node:crypto';
import { estimateEtaMinutes, haversineKm, type DeliveryMode, type GeoPoint } from '@slice/shared';

/**
 * Delivery provider port. A pizzeria either uses the franchise's own courier fleet or a third-party
 * delivery chain. Both report progress back as the same `delivery` workflow signal (couriers via the
 * courier app → API, partners via signed webhooks → API).
 */
export interface DispatchRequest {
  orderId: string;
  pizzeriaId: string;
  brandName: string;
  pickup: GeoPoint & { address: string };
  dropoff: GeoPoint & { addressLine: string };
}

export interface DeliveryProvider {
  readonly name: string;
  dispatch(req: DispatchRequest): Promise<{ externalRef: string; etaMinutes: number }>;
  cancel(externalRef: string): Promise<void>;
}

const ref = (prefix: string, orderId: string) =>
  `${prefix}_${createHash('sha1').update(orderId).digest('hex').slice(0, 12)}`;

/** Franchise-owned couriers. Assignment is simulated; production would call the fleet dispatcher. */
export class OwnFleet implements DeliveryProvider {
  readonly name = 'own_fleet';
  async dispatch(req: DispatchRequest) {
    const km = haversineKm(req.pickup, req.dropoff);
    return { externalRef: ref('fleet', req.orderId), etaMinutes: estimateEtaMinutes(km, 0, 10) - 12 + 3 };
  }
  async cancel() {}
}

/**
 * Third-party delivery chain ("CourierCo"). The order is delivered under the *brand* of the kitchen
 * (virtual brands included), so the courier bag and the tracking page show e.g. "Night Owl Pizza".
 * If COURIERCO_URL is set the request is POSTed there; otherwise it is simulated.
 */
export class CourierCo implements DeliveryProvider {
  readonly name = 'courierco';
  constructor(private readonly baseUrl = process.env.COURIERCO_URL, private readonly apiKey = process.env.COURIERCO_KEY) {}

  async dispatch(req: DispatchRequest) {
    const externalRef = ref('cc', req.orderId);
    const km = haversineKm(req.pickup, req.dropoff);
    if (this.baseUrl) {
      const res = await fetch(`${this.baseUrl}/v1/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey ?? ''}`, 'idempotency-key': externalRef },
        body: JSON.stringify({ reference: externalRef, brand: req.brandName, pickup: req.pickup, dropoff: req.dropoff }),
      });
      if (!res.ok) throw new Error(`CourierCo dispatch failed: ${res.status}`);
      const body = (await res.json()) as { eta_minutes?: number };
      return { externalRef, etaMinutes: body.eta_minutes ?? Math.ceil((km / 15) * 60) + 8 };
    }
    return { externalRef, etaMinutes: Math.ceil((km / 15) * 60) + 8 };
  }
  async cancel(externalRef: string) {
    if (this.baseUrl) await fetch(`${this.baseUrl}/v1/jobs/${externalRef}/cancel`, { method: 'POST' });
  }
}

export function providerFor(mode: DeliveryMode, providers: { ownFleet: DeliveryProvider; thirdParty: DeliveryProvider }) {
  return mode === 'own_fleet' ? providers.ownFleet : providers.thirdParty;
}
