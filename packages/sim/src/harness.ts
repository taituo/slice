import { randomUUID } from 'node:crypto';
import { runDeepAgent, llmFromEnv, type AgentDef, type Memory, type ChatTurn } from '@slice/agents';
import { A2UI_EXTENSION_URI, A2UI_MIME, SliceClient, type A2uiServerMessage, type OrderStatus } from '@slice/shared';

/**
 * Test harness on the same deep-agent runtime as the product: every simulated person is an agent
 * that talks to the platform's agent over A2A (with A2UI), presses the buttons it is shown, walks
 * around on the map, and signs in with a connected-assistant token like a real user's assistant.
 */

export const API = process.env.API_URL ?? 'http://localhost:4000';
export const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'dev-admin-key';
export const PARTNER_KEY = process.env.PARTNER_API_KEY ?? 'dev-partner-key';

export const staff = new SliceClient(API, { adminKey: ADMIN_KEY, partnerKey: PARTNER_KEY });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Button {
  surfaceId: string;
  componentId: string;
  label: string;
  action: string;
  context: Record<string, unknown>;
}

export interface Exchange {
  reply: string;
  ui: A2uiServerMessage[];
  data: unknown[];
  ms: number;
}

/** Pull pressable buttons (with their labels) out of A2UI surfaces. */
export function buttonsIn(ui: A2uiServerMessage[]): Button[] {
  const out: Button[] = [];
  for (const m of ui) {
    if (!('updateComponents' in m)) continue;
    const comps = m.updateComponents.components;
    for (const c of comps) {
      if (c.component !== 'Button') continue;
      const ev = (c.action as { event?: { name: string; context: Record<string, unknown> } })?.event;
      if (!ev) continue;
      const label = String(comps.find((x) => x.id === c.child)?.text ?? '');
      out.push({ surfaceId: m.updateComponents.surfaceId, componentId: c.id, label, action: ev.name, context: ev.context });
    }
  }
  return out;
}

export interface PersonOptions {
  name: string;
  phone: string;
  tenant: string;
  position: { lat: number; lng: number; addressLine?: string };
  persona?: string;
}

/** A simulated person whose behaviour runs on the deep-agent runtime. */
export class DummyCustomer {
  readonly contextId = randomUUID();
  readonly transcript: Array<{ from: 'customer' | 'platform'; text: string }> = [];
  lastUi: A2uiServerMessage[] = [];
  lastData: unknown[] = [];
  token: string | null = null;
  sessionToken: string | null = null;
  customerId: string | null = null;
  position: { lat: number; lng: number; addressLine?: string };
  private turns: ChatTurn[] = [];
  private readonly agent: AgentDef;

  constructor(readonly opts: PersonOptions) {
    this.position = { ...opts.position };
    const self = this;
    // The person's own agent: two tools (talk to the platform, press a button) + a scripted fallback.
    this.agent = {
      id: `customer-${opts.name}`,
      name: opts.name,
      description: 'a simulated customer',
      instructions: `You are ${opts.name}, a customer. ${opts.persona ?? ''} Use talk to speak to the service and press to tap buttons it shows. Be brief.`,
      tools: [
        {
          name: 'talk',
          description: 'Say something to the service',
          parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          run: async (a) => {
            const r = await self.a2a([{ kind: 'text', text: String(a.text) }]);
            return { data: { reply: r.reply, buttons: buttonsIn(r.ui).map((b) => b.label) }, say: r.reply };
          },
        },
        {
          name: 'press',
          description: 'Tap a button shown by the service, by its label or action name',
          parameters: { type: 'object', properties: { label: { type: 'string' }, index: { type: 'number' } }, required: ['label'] },
          run: async (a) => {
            const r = await self.pressButton(String(a.label), Number(a.index ?? 0));
            return { data: { reply: r.reply }, say: r.reply };
          },
        },
      ],
      fallback: async ({ text, call }) => {
        const [verb, ...rest] = text.split(':');
        const arg = rest.join(':').trim();
        if (verb === 'SAY') return { reply: (await call('talk', { text: arg })).say ?? '', ui: [], toolCalls: [] };
        if (verb === 'PRESS') {
          const [label, index] = arg.split('#');
          return { reply: (await call('press', { label: label!, index: Number(index ?? 0) })).say ?? '', ui: [], toolCalls: [] };
        }
        return null;
      },
    };
  }

  private memory: Memory = {
    load: async () => this.turns,
    append: async (_s, t) => void this.turns.push(t),
    savePlan: async () => undefined,
  };

  /** Sign in by phone code and connect "my assistant" — the token this agent then uses. */
  async signIn() {
    const anon = new SliceClient(API);
    const start = await (anon as any).req('POST', '/v1/auth/otp/start', { phone: this.opts.phone });
    const v = await (anon as any).req('POST', '/v1/auth/otp/verify', { phone: this.opts.phone, code: start.devCode });
    const session = new SliceClient(API, { token: v.token });
    const asst = await (session as any).req('POST', '/v1/me/assistants', { label: `${this.opts.name}'s assistant`, scopes: ['browse', 'order', 'track', 'support'] });
    this.customerId = v.customerId;
    this.sessionToken = v.token;
    this.token = asst.token;
    return this;
  }

  /** Deterministic step (offline) — or, with an LLM key and `goal`, let the agent improvise. */
  async say(text: string): Promise<Exchange> {
    await this.run(`SAY: ${text}`);
    return this.last!;
  }
  async press(labelOrAction: string, index = 0): Promise<Exchange> {
    await this.run(`PRESS: ${labelOrAction}#${index}`);
    return this.last!;
  }
  async pursue(goal: string) {
    const llm = llmFromEnv();
    if (!llm) throw new Error('pursue() needs LLM_API_KEY / DEEPSEEK_API_KEY; use say()/press() offline');
    return runDeepAgent(this.agent, { sessionId: this.contextId, text: goal }, ctxFor(this), { llm, memory: this.memory });
  }

  private last: Exchange | null = null;
  private async run(command: string) {
    await runDeepAgent(this.agent, { sessionId: this.contextId, text: command }, ctxFor(this), { llm: null, memory: this.memory });
  }

  buttons() {
    return buttonsIn(this.lastUi);
  }

  async pressButton(labelOrAction: string, index = 0): Promise<Exchange> {
    const matches = this.buttons().filter((b) => b.label === labelOrAction || b.action === labelOrAction);
    const b = matches[index];
    if (!b) throw new Error(`${this.opts.name}: no button "${labelOrAction}" (have: ${this.buttons().map((x) => x.label).join(', ') || 'none'})`);
    return this.a2a([
      {
        kind: 'data',
        metadata: { mimeType: A2UI_MIME },
        data: [{ version: 'v1.0', action: { name: b.action, surfaceId: b.surfaceId, sourceComponentId: b.componentId, timestamp: new Date().toISOString(), context: b.context, userMessage: b.label } }],
      },
    ]);
  }

  async a2a(parts: unknown[]): Promise<Exchange> {
    const t0 = Date.now();
    const text = (parts as Array<{ kind: string; text?: string }>).find((p) => p.kind === 'text')?.text;
    if (text) this.transcript.push({ from: 'customer', text });
    else this.transcript.push({ from: 'customer', text: `[taps] ${JSON.stringify((parts as any)[0]?.data?.[0]?.action?.userMessage ?? '')}` });
    const res = await fetch(`${API}/t/${this.opts.tenant}/a2a`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-a2a-extensions': A2UI_EXTENSION_URI,
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'message/send',
        params: { message: { role: 'user', messageId: randomUUID(), contextId: this.contextId, parts }, metadata: { location: this.position } },
      }),
    });
    const body = (await res.json()) as any;
    if (body.error) throw new Error(`${this.opts.name}: A2A error ${body.error.message}`);
    const out = body.result.parts as Array<{ kind: string; text?: string; data?: any; metadata?: { mimeType?: string } }>;
    const reply = out.filter((p) => p.kind === 'text').map((p) => p.text).join(' ');
    const ui = out.filter((p) => p.kind === 'data' && p.metadata?.mimeType === A2UI_MIME).flatMap((p) => p.data as A2uiServerMessage[]);
    const data = out.filter((p) => p.kind === 'data' && p.metadata?.mimeType !== A2UI_MIME).map((p) => p.data);
    if (ui.length) this.lastUi = ui;
    this.lastData = data;
    this.transcript.push({ from: 'platform', text: reply });
    this.last = { reply, ui, data, ms: Date.now() - t0 };
    return this.last;
  }

  /** Tool results the platform agent returned last turn (e.g. the order id). */
  findInData<T = any>(pick: (r: any) => T | undefined): T | undefined {
    for (const d of this.lastData as any[]) {
      for (const c of d?.toolCalls ?? []) {
        const v = pick(c.result);
        if (v !== undefined) return v;
      }
      if (d?.result) {
        const v = pick(d.result);
        if (v !== undefined) return v;
      }
    }
    return undefined;
  }
}

function ctxFor(c: DummyCustomer) {
  return { tenantId: c.opts.tenant, sessionId: c.contextId, channel: 'sim', customerId: c.customerId, location: c.position, a2ui: false };
}

export async function waitForOrder(orderId: string, statuses: OrderStatus[], timeoutMs = 15_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await staff.order(orderId);
    if (statuses.includes(v.status)) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`order ${orderId} stuck at ${v.status}, wanted ${statuses.join('|')}`);
    await sleep(120);
  }
}

export async function until<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000, what = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

export async function adminReq<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  return (staff as any).req(method, path, body);
}
