import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { callbackByConversation, findCustomerByPhone, getCallback, logVoiceCall } from '@slice/db';
import { callbackOutcomeSignal, getTemporalClient, verifyElevenLabsSignature } from '@slice/workflows';
import { executeTool, runAgentFor } from './agents';
import { openSupportCase } from './platform';

/**
 * Voice with ElevenLabs Agents:
 *  1. Custom LLM — the ElevenLabs agent's "LLM" is our deep agent, behind an OpenAI-compatible
 *     /chat/completions endpoint. Callers talk to the same agent as chat and A2A.
 *  2. Server tools — alternatively the ElevenLabs agent runs its own LLM and calls our tools by webhook.
 *  3. Post-call webhook — transcripts and outcomes come back signed; failed calls open a support case.
 * Outbound calls are placed by the notifier (workflows/adapters/voice.ts).
 */
const TOOL_SECRET = process.env.VOICE_TOOL_SECRET ?? 'dev-voice-secret';
const LLM_KEY = process.env.VOICE_LLM_KEY ?? 'dev-voice-llm-key';
const WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET ?? 'dev-elevenlabs-secret';
const VOICE_TENANT = process.env.VOICE_TENANT ?? 'nearby';

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function registerVoice(app: FastifyInstance) {
  // ---------------------------------------------------------------- 1. custom LLM endpoint
  app.post('/v1/voice/llm/chat/completions', async (req, reply) => {
    const auth = String(req.headers.authorization ?? '');
    if (!same(auth, `Bearer ${LLM_KEY}`)) return reply.code(401).send({ error: 'unauthorized' });
    const body = req.body as {
      messages: Array<{ role: string; content: string | null }>;
      stream?: boolean;
      user?: string;
      elevenlabs_extra_body?: { caller_id?: string; conversation_id?: string; tenant?: string; callback_ref?: string };
    };
    const extra = body.elevenlabs_extra_body ?? {};
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    // An AI callback carries its own reference: the agent already knows who it called and why.
    const cb = extra.callback_ref ? await getCallback(extra.callback_ref) : null;
    const caller = extra.caller_id ?? (req.headers['x-caller-id'] as string | undefined);
    const customerId = cb?.customerId ?? (caller ? await findCustomerByPhone(caller) : null);
    const conv = extra.conversation_id ?? body.user ?? createHash('sha1').update(JSON.stringify(body.messages[0] ?? '')).digest('hex').slice(0, 16);
    const sessionId = cb ? `callback-${cb.id}` : `voice-${conv}`;
    const r = await runAgentFor(cb?.tenantId ?? extra.tenant ?? VOICE_TENANT, { sessionId, text: lastUser }, { channel: 'voice', customerId, a2ui: false });
    // Voice wants speakable text: no markdown, no codes read out character by character.
    const speak = speakable(r.reply);
    const id = `chatcmpl-${conv}-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    if (body.stream) {
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'slice-deep-agent', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      reply.raw.write(chunk({ role: 'assistant', content: speak }, null));
      reply.raw.write(chunk({}, 'stop'));
      reply.raw.end('data: [DONE]\n\n');
      return reply;
    }
    return {
      id,
      object: 'chat.completion',
      created,
      model: 'slice-deep-agent',
      choices: [{ index: 0, message: { role: 'assistant', content: speak }, finish_reason: 'stop' }],
    };
  });

  // ---------------------------------------------------------------- 2. server tools (webhook per tool)
  app.post('/v1/voice/tools/:tool', async (req, reply) => {
    if (!same(String(req.headers['x-voice-secret'] ?? ''), TOOL_SECRET)) return reply.code(401).send({ error: 'unauthorized' });
    const { tool } = req.params as { tool: string };
    const { caller_id, conversation_id, tenant, ...args } = (req.body ?? {}) as Record<string, unknown>;
    const customerId = typeof caller_id === 'string' ? await findCustomerByPhone(caller_id) : null;
    const r = await executeTool(tool, args, {
      tenantId: typeof tenant === 'string' ? tenant : VOICE_TENANT,
      sessionId: `voice-${String(conversation_id ?? 'unknown')}`,
      channel: 'voice',
      customerId,
      a2ui: false,
    });
    return { result: r.say ?? 'Done.', data: r.data };
  });

  // ---------------------------------------------------------------- 3. post-call webhook
  app.post('/v1/voice/elevenlabs/post-call', async (req, reply) => {
    const raw = req.rawBody ?? JSON.stringify(req.body);
    if (!verifyElevenLabsSignature(req.headers['elevenlabs-signature'] as string | undefined, raw, WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: 'bad_signature' });
    }
    const evt = req.body as { type: string; data?: any };
    const d = evt.data ?? {};
    // Callback outcome: tell the waiting callback workflow how its call went.
    const cb = d.conversation_id ? await callbackByConversation(d.conversation_id) : null;
    if (cb) {
      const status = evt.type === 'call_initiation_failure' ? 'no_answer' : d.analysis?.call_successful === 'failure' && !(d.transcript?.length > 1) ? 'no_answer' : 'completed';
      await (await getTemporalClient()).workflow.getHandle(cb.id).signal(callbackOutcomeSignal, { status, summary: d.analysis?.transcript_summary }).catch(() => undefined);
      if (evt.type !== 'post_call_transcription' || status === 'completed') return { status: 'received', callbackId: cb.id, outcome: status };
    }
    if (evt.type !== 'post_call_transcription') return { status: 'ignored' };
    const summary: string = d.analysis?.transcript_summary ?? '';
    const failed = d.analysis?.call_successful === 'failure';
    await logVoiceCall({ provider: 'elevenlabs', direction: 'inbound', conversationId: d.conversation_id, purpose: 'conversation', status: failed ? 'unsuccessful' : 'completed', summary });
    let caseId: string | null = null;
    if (failed || /refund|complain|angry|missing|late|wrong/i.test(summary)) {
      const caller = d.metadata?.phone_call?.external_number ?? d.conversation_initiation_client_data?.dynamic_variables?.system__caller_id;
      const customerId = caller ? await findCustomerByPhone(caller) : null;
      const v = await openSupportCase({ tenantId: VOICE_TENANT, customerId, message: `Phone call follow-up: ${summary || 'call did not reach a resolution'}`, channel: 'voice' });
      caseId = v.caseId;
    }
    return { status: 'received', caseId };
  });
}

/** Phone replies: no markdown, no internal ids ("Order number ord_x." → dropped), tidy spacing. */
export function speakable(text: string): string {
  return text
    .replace(/\s*\(?\b(?:order number|booking|case)?\s*\b(?:ord|bk|case|rfq|cb|btn)_[A-Za-z0-9_]+\)?\.?/gi, '.')
    .replace(/[*`#]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
