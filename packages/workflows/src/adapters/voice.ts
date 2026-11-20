import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * ElevenLabs voice agents. Outbound: the platform asks ElevenLabs to call a customer with a given
 * agent (order on the way, class reminder, support callback). Inbound: customers call the number
 * attached to that agent; the agent's "custom LLM" is our own deep agent (OpenAI-compatible
 * endpoint) and its server tools hit our API, so the voice line is the same agent as chat and A2A.
 */
export interface OutboundCall {
  to: string;
  purpose: string;
  variables: Record<string, string | number>;
}

export interface VoiceProvider {
  readonly name: string;
  readonly live: boolean;
  call(req: OutboundCall): Promise<{ conversationId: string | null; dryRun: boolean }>;
}

export class ElevenLabsVoice implements VoiceProvider {
  readonly name = 'elevenlabs';
  constructor(
    private readonly apiKey = process.env.ELEVENLABS_API_KEY,
    private readonly agentId = process.env.ELEVENLABS_AGENT_ID,
    private readonly phoneNumberId = process.env.ELEVENLABS_PHONE_NUMBER_ID,
    private readonly baseUrl = process.env.ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io',
  ) {}

  get live() {
    return Boolean(this.apiKey && this.agentId && this.phoneNumberId);
  }

  async call(req: OutboundCall) {
    if (!this.live) return { conversationId: null, dryRun: true };
    const res = await fetch(`${this.baseUrl}/v1/convai/twilio/outbound-call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'xi-api-key': this.apiKey! },
      body: JSON.stringify({
        agent_id: this.agentId,
        agent_phone_number_id: this.phoneNumberId,
        to_number: req.to,
        conversation_initiation_client_data: { dynamic_variables: { purpose: req.purpose, ...req.variables } },
      }),
    });
    if (!res.ok) throw new Error(`ElevenLabs outbound call failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { conversation_id?: string };
    return { conversationId: body.conversation_id ?? null, dryRun: false };
  }
}

/**
 * Verifies the `ElevenLabs-Signature: t=<unix>,v0=<hex>` header: HMAC-SHA256 over `${t}.${rawBody}`
 * with the webhook secret, rejecting timestamps older than 30 minutes.
 */
export function verifyElevenLabsSignature(header: string | undefined, rawBody: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim());
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const sigs = parts.filter((p) => p.startsWith('v0=')).map((p) => p.slice(3));
  if (!t || !sigs.length || !/^\d+$/.test(t)) return false;
  if (nowSec - Number(t) > 30 * 60) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

export function signElevenLabs(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v0=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}
