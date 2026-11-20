/** Domain types shared by API, workflows, MCP server and every client (web, mobile, XR). */

export type OrderStatus =
  | 'received'
  | 'routed'
  | 'payment_authorized'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled'
  | 'failed';

export const TERMINAL_STATUSES: OrderStatus[] = ['delivered', 'cancelled', 'failed'];

export type DeliveryMode = 'own_fleet' | 'third_party';
export type BrandKind = 'real' | 'virtual';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Brand {
  id: string;
  name: string;
  kind: BrandKind;
  tagline: string;
  accentColor: string;
}

export interface Pizzeria {
  id: string;
  brandId: string;
  brandName: string;
  name: string;
  region: string;
  address: string;
  lat: number;
  lng: number;
  deliveryMode: DeliveryMode;
  capacityPer15Min: number;
  status: 'open' | 'paused' | 'closed';
}

export interface NearbyPizzeria extends Pizzeria {
  distanceKm: number;
  activeOrders: number;
  etaMinutes: number;
}

export interface MenuItem {
  sku: string;
  name: string;
  description: string;
  category: 'pizza' | 'side' | 'drink' | 'dessert';
  basePriceCents: number;
  tags: string[];
}

export interface CartLine {
  sku: string;
  qty: number;
}

export interface PricedLine extends CartLine {
  name: string;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface Campaign {
  code: string;
  name: string;
  percentOff: number;
  startsAt: string;
  endsAt: string;
  regions: string[] | null;
  skus: string[] | null;
}

export interface Quote {
  lines: PricedLine[];
  subtotalCents: number;
  discountCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  currency: 'EUR';
  campaignCode: string | null;
  experimentVariant: string;
}

export interface OrderTimelineEvent {
  type: string;
  at: string;
  detail?: Record<string, unknown>;
}

/** What the workflow exposes through its `status` query — the live view of an order. */
export interface OrderView {
  orderId: string;
  status: OrderStatus;
  pizzeriaId: string | null;
  pizzeriaName: string | null;
  brandName: string | null;
  attemptedPizzerias: string[];
  quote: Quote | null;
  delivery: { provider: string; externalRef: string; etaMinutes: number } | null;
  /** Live courier position, updated by `courierLocation` signals while out for delivery. */
  tracking: CourierTracking | null;
  offerId: string | null;
  timeline: OrderTimelineEvent[];
  failureReason: string | null;
}

export interface CourierTracking {
  lat: number;
  lng: number;
  at: string;
  remainingKm: number;
  etaMinutes: number;
  progress: number; // 0..1 from kitchen to door
}

export interface PlaceOrderInput {
  customer: {
    name: string;
    phone: string;
    email?: string;
    marketingConsent?: boolean;
  };
  delivery: GeoPoint & { addressLine: string };
  items: CartLine[];
  channel: 'web' | 'mobile' | 'xr' | 'agent' | 'mcp' | 'a2a' | 'phone' | 'sms' | 'voice';
  notifyBy?: Array<'sms' | 'call' | 'push' | 'email'>;
  offerId?: string;
  adId?: string;
}
