import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveToken } from '@slice/db';

export interface Principal {
  tokenId: string;
  customerId: string;
  kind: 'session' | 'assistant';
  scopes: string[];
  label: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    rawBody?: string;
  }
}

/**
 * Bearer tokens for people (`sk_sess_…`, from phone OTP) and for the assistants they connect
 * (`sk_asst_…`: ChatGPT, Claude, a personal agent over A2A, a voice assistant). Tokens are stored
 * hashed and carry scopes; an assistant can be revoked at any time.
 */
export function registerAuth(app: FastifyInstance) {
  app.decorateRequest('principal', null);
  app.addHook('preHandler', async (req) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer sk_')) return;
    const t = await resolveToken(h.slice(7));
    if (t) req.principal = { tokenId: t.id, customerId: t.customerId, kind: t.kind as Principal['kind'], scopes: t.scopes, label: t.label };
  });
}

export const requireCustomer = (scope?: string) => async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.principal) return reply.code(401).send({ error: 'unauthorized', message: 'Sign in first (phone code) or use an assistant token.' });
  if (scope && req.principal.kind === 'assistant' && !req.principal.scopes.includes(scope)) {
    return reply.code(403).send({ error: 'forbidden', message: `This assistant token lacks the "${scope}" scope.` });
  }
};

/** Scope check for tool calls made by connected assistants. */
export function scopeForTool(tool: string): string {
  if (['open_support_case', 'support_case_status'].includes(tool)) return 'support';
  if (['order_status', 'booking_status'].includes(tool)) return 'track';
  if (['place_order', 'choose_offer', 'book_class', 'cancel_order', 'cancel_booking'].includes(tool)) return 'order';
  return 'browse';
}
