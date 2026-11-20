import type {
  Brand,
  Campaign,
  CartLine,
  MenuItem,
  NearbyPizzeria,
  OrderView,
  Pizzeria,
  PlaceOrderInput,
  Quote,
} from './types';

/**
 * Typed SDK for every client surface: React web, React Native (iOS/Android), WebXR (Vision Pro,
 * Quest), smart-glasses voice shells, and the MCP server. Uses only `fetch`, so it runs everywhere.
 */
export class SliceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: { adminKey?: string; partnerKey?: string; token?: string; tenant?: string; fetchImpl?: typeof fetch } = {},
  ) {}

  private async req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.opts.adminKey ? { 'x-admin-key': this.opts.adminKey } : {}),
        ...(this.opts.partnerKey ? { 'x-partner-key': this.opts.partnerKey } : {}),
        ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
        ...(this.opts.tenant ? { 'x-tenant': this.opts.tenant } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || res.statusText;
      throw new SliceApiError(res.status, String(msg), data);
    }
    return data as T;
  }

  nearest(lat: number, lng: number, limit = 3) {
    return this.req<{ pizzerias: NearbyPizzeria[] }>('GET', `/v1/pizzerias/nearest?lat=${lat}&lng=${lng}&limit=${limit}`);
  }
  brands() {
    return this.req<{ brands: Brand[] }>('GET', '/v1/brands');
  }
  pizzerias(region?: string) {
    return this.req<{ pizzerias: Pizzeria[] }>('GET', `/v1/pizzerias${region ? `?region=${encodeURIComponent(region)}` : ''}`);
  }
  menu(pizzeriaId?: string) {
    return this.req<{ items: MenuItem[]; overrides: Record<string, number> }>(
      'GET',
      `/v1/menu${pizzeriaId ? `?pizzeriaId=${encodeURIComponent(pizzeriaId)}` : ''}`,
    );
  }
  campaigns(activeOnly = true) {
    return this.req<{ campaigns: Campaign[] }>('GET', `/v1/campaigns${activeOnly ? '?active=true' : ''}`);
  }
  quote(lat: number, lng: number, items: CartLine[], customerKey?: string) {
    return this.req<{ quote: Quote; pizzeria: NearbyPizzeria }>('POST', '/v1/quote', { lat, lng, items, customerKey });
  }
  placeOrder(input: PlaceOrderInput, idempotencyKey?: string) {
    return this.req<{ orderId: string; status: string; trackingUrl: string }>(
      'POST',
      '/v1/orders',
      input,
      idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    );
  }
  order(orderId: string) {
    return this.req<OrderView>('GET', `/v1/orders/${encodeURIComponent(orderId)}`);
  }
  cancel(orderId: string, reason = 'customer_request') {
    return this.req<{ ok: boolean }>('POST', `/v1/orders/${encodeURIComponent(orderId)}/cancel`, { reason });
  }
  kitchen(orderId: string, action: 'accept' | 'ready' | 'reject', reason?: string, pizzeriaId?: string) {
    return this.req<{ ok: boolean }>('POST', `/v1/orders/${encodeURIComponent(orderId)}/kitchen`, { action, reason, pizzeriaId });
  }
  delivery(orderId: string, status: 'picked_up' | 'delivered' | 'failed', reason?: string) {
    return this.req<{ ok: boolean }>('POST', `/v1/orders/${encodeURIComponent(orderId)}/delivery`, { status, reason });
  }
  agentChat(messages: Array<{ role: 'user' | 'assistant'; content: string }>, context?: Record<string, unknown>) {
    return this.req<AgentChatResponse>('POST', '/v1/agent/chat', { messages, context });
  }
  /** Deep-agent chat turn with a session (memory), optional A2UI action, any tenant. */
  chat(input: { tenant?: string; sessionId?: string; message?: string; action?: unknown; context?: Record<string, unknown> }) {
    return this.req<AgentChatResponse>('POST', '/v1/agent/chat', input);
  }
  callTool(name: string, args: Record<string, unknown>, extra: { tenant?: string; sessionId?: string; location?: unknown } = {}) {
    return this.req<{ data: unknown; say: string | null }>('POST', `/v1/tools/${encodeURIComponent(name)}`, { args, ...extra });
  }
  offers(input: { vertical: 'food' | 'fitness' | 'retail'; lat: number; lng: number; query?: string; items?: CartLine[]; preference?: string; tenant?: string; customerKey?: string }) {
    return this.req<{ requestId: string; providersAsked: number; providersAnswered: number; countered: number; offers: Array<Record<string, any>> }>('POST', '/v1/offers', input);
  }
  acceptOffer(offerId: string, body: { name?: string; phone?: string; addressLine?: string } = {}) {
    return this.req<Record<string, any>>('POST', `/v1/offers/${encodeURIComponent(offerId)}/accept`, body);
  }
  location(orderId: string, lat: number, lng: number) {
    return this.req<{ ok: boolean }>('POST', `/v1/orders/${encodeURIComponent(orderId)}/location`, { lat, lng });
  }
  signal(kind: string, detail: Record<string, unknown>, source = 'web') {
    return this.req<{ ok: boolean }>('POST', '/v1/signals', { kind, detail, source });
  }
}

export interface AgentChatResponse {
  reply: string;
  ui: unknown[];
  toolCalls: Array<{ agent?: string; name: string; args: unknown; result: unknown }>;
  engine: string;
  sessionId: string;
  plan: Array<{ content: string; status: string }>;
}

export class SliceApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}
