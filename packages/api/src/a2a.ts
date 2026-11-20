import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getTenant } from '@slice/db';
import {
  A2UI_BASIC_CATALOG,
  A2UI_EXTENSION_URI,
  A2UI_MIME,
  toolCatalog,
  type A2uiAction,
  type AgentToolName,
} from '@slice/shared';
import { agentTaskQuery, getTemporalClient, OPS_QUEUE } from '@slice/workflows';
import { conciergeFor, executeTool, runAgentFor } from './agents';
import { scopeForTool } from './auth';

/**
 * Agent-to-Agent (A2A). Every tenant's concierge is reachable at /t/<tenant>/a2a with its own agent
 * card; /a2a and /.well-known/agent-card.json serve the default tenant. Supports:
 *  - text parts → the deep agent (same as the chat)
 *  - data parts `{ tool, args }` → a deterministic tool call
 *  - data parts with mimeType application/a2ui+json → A2UI actions (button presses)
 *  - A2UI output when the client activates the extension (X-A2A-Extensions) or sends renderer capabilities
 *  - `configuration.blocking: false` → a durable Temporal task, polled with `tasks/get`
 */
const DEFAULT_TENANT = process.env.DEFAULT_TENANT ?? 'slice';

export async function agentCard(publicUrl: string, tenantId: string) {
  const tenant = await getTenant(tenantId);
  const def = await conciergeFor(tenantId);
  const names = new Set<string>();
  const walk = (d: typeof def) => {
    d.tools.forEach((t) => names.add(t.name));
    d.subagents?.forEach(walk);
  };
  walk(def);
  const base = tenantId === DEFAULT_TENANT ? publicUrl : `${publicUrl}/t/${tenantId}`;
  return {
    protocolVersion: '0.3.0',
    name: def.name,
    description: tenant?.branding
      ? `${tenant.name}: ${def.description}.`
      : `A neutral local assistant: ${def.description}. Nearby providers compete with offers.`,
    url: `${base}/a2a`,
    preferredTransport: 'JSONRPC',
    version: '0.2.0',
    provider: { organization: tenant?.branding ? tenant.name : 'White-label platform', url: publicUrl },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [{ uri: A2UI_EXTENSION_URI, required: false, params: { supportedCatalogIds: [A2UI_BASIC_CATALOG], acceptsInlineCatalogs: false } }],
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [...names]
      .filter((n) => n in toolCatalog)
      .map((id) => ({ id, name: id.replace(/_/g, ' '), description: toolCatalog[id as AgentToolName].description, tags: [toolCatalog[id as AgentToolName].domain] })),
  };
}

type Part = { kind: 'text'; text: string } | { kind: 'data'; data: any; metadata?: Record<string, unknown> };

function wantsA2ui(req: FastifyRequest, params: any): boolean {
  const ext = String(req.headers['x-a2a-extensions'] ?? '');
  return ext.includes('a2ui.org/a2a-extension/a2ui') || Boolean(params?.message?.metadata?.a2uiRendererCapabilities ?? params?.metadata?.a2uiRendererCapabilities);
}

export function registerA2a(app: FastifyInstance, publicUrl: string) {
  const cardRoute = async (tenantId: string) => agentCard(publicUrl, tenantId);
  app.get('/.well-known/agent-card.json', async () => cardRoute(DEFAULT_TENANT));
  app.get('/.well-known/agent.json', async () => cardRoute(DEFAULT_TENANT));
  app.get('/t/:tenant/.well-known/agent-card.json', async (req) => cardRoute((req.params as { tenant: string }).tenant));

  const handler = (tenantFrom: (req: FastifyRequest) => string) => async (req: FastifyRequest, reply: any) => {
    const tenantId = tenantFrom(req);
    const body = req.body as { jsonrpc?: string; id?: string | number; method?: string; params?: any };
    const id = body?.id ?? null;
    const fail = (code: number, message: string) => reply.send({ jsonrpc: '2.0', id, error: { code, message } });
    if (body?.jsonrpc !== '2.0' || !body.method) return fail(-32600, 'Invalid Request');
    const customerId = req.principal?.customerId ?? null;
    const a2ui = wantsA2ui(req, body.params);
    if (a2ui) reply.header('X-A2A-Extensions', A2UI_EXTENSION_URI);

    if (body.method === 'tasks/get') {
      const taskId = String(body.params?.id ?? '');
      try {
        const handle = (await getTemporalClient()).workflow.getHandle(taskId);
        const t = await handle.query(agentTaskQuery);
        const desc = await handle.describe();
        return reply.send({ jsonrpc: '2.0', id, result: taskObject(taskId, String(desc.memo?.contextId ?? ''), t, a2ui) });
      } catch {
        return fail(-32001, 'Task not found');
      }
    }
    if (body.method !== 'message/send') return fail(-32601, `Method not found: ${body.method}`);

    const message = body.params?.message ?? {};
    const parts: Part[] = message.parts ?? [];
    const contextId: string = message.contextId ?? randomUUID();
    const sessionId = `a2a-${tenantId}-${contextId}`;
    const text = parts.filter((p): p is Extract<Part, { kind: 'text' }> => p.kind === 'text').map((p) => p.text).join('\n');
    const meta = body.params?.metadata ?? message.metadata ?? {};

    if (body.params?.configuration?.blocking === false && text) {
      const taskId = `task_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
      await (await getTemporalClient()).workflow.start('agentTaskWorkflow', {
        workflowId: taskId,
        taskQueue: OPS_QUEUE,
        args: [{ tenantId, sessionId, text, customerToken: token }],
        memo: { contextId },
      });
      return reply.send({ jsonrpc: '2.0', id, result: { kind: 'task', id: taskId, contextId, status: { state: 'submitted', timestamp: new Date().toISOString() } } });
    }

    const out: Part[] = [];
    try {
      for (const p of parts) {
        if (p.kind !== 'data') continue;
        if (p.metadata?.mimeType === A2UI_MIME && Array.isArray(p.data)) {
          for (const m of p.data) {
            if (!m?.action) continue;
            const r = await runAgentFor(tenantId, { sessionId, action: m.action as A2uiAction }, { channel: 'a2a', customerId, location: meta.location, a2ui });
            out.push({ kind: 'text', text: r.reply });
            if (a2ui && r.ui.length) out.push({ kind: 'data', data: r.ui, metadata: { mimeType: A2UI_MIME } });
            out.push({ kind: 'data', data: { toolCalls: r.toolCalls.map((c) => ({ name: c.name, result: c.result })) } });
          }
        } else if (typeof p.data?.tool === 'string') {
          const scope = scopeForTool(p.data.tool);
          if (req.principal?.kind === 'assistant' && !req.principal.scopes.includes(scope)) {
            out.push({ kind: 'data', data: { tool: p.data.tool, error: `missing scope ${scope}` } });
            continue;
          }
          const r = await executeTool(p.data.tool, p.data.args ?? {}, { tenantId, sessionId, channel: 'a2a', customerId, location: meta.location, a2ui });
          out.push({ kind: 'data', data: { tool: p.data.tool, result: r.data } });
          if (a2ui && r.ui?.length) out.push({ kind: 'data', data: r.ui, metadata: { mimeType: A2UI_MIME } });
        }
      }
      if (text) {
        const r = await runAgentFor(tenantId, { sessionId, text }, { channel: 'a2a', customerId, location: meta.location, a2ui });
        out.push({ kind: 'text', text: r.reply });
        if (a2ui && r.ui.length) out.push({ kind: 'data', data: r.ui, metadata: { mimeType: A2UI_MIME } });
        if (r.toolCalls.length) out.push({ kind: 'data', data: { toolCalls: r.toolCalls.map((c) => ({ name: c.name, result: c.result })) } });
      }
    } catch (err) {
      return fail(-32000, (err as Error).message);
    }
    return reply.send({ jsonrpc: '2.0', id, result: { kind: 'message', role: 'agent', messageId: randomUUID(), contextId, parts: out } });
  };

  app.post('/a2a', handler(() => DEFAULT_TENANT));
  app.post('/t/:tenant/a2a', handler((req) => (req.params as { tenant: string }).tenant));
}

function taskObject(id: string, contextId: string, t: { state: string; reply: string | null; ui: unknown[]; error: string | null }, a2ui: boolean) {
  const parts: Part[] = [];
  if (t.reply) parts.push({ kind: 'text', text: t.reply });
  if (a2ui && t.ui.length) parts.push({ kind: 'data', data: t.ui, metadata: { mimeType: A2UI_MIME } });
  return {
    kind: 'task',
    id,
    contextId,
    status: { state: t.state, timestamp: new Date().toISOString(), ...(t.error ? { message: { role: 'agent', parts: [{ kind: 'text', text: t.error }] } } : {}) },
    artifacts: parts.length ? [{ artifactId: `${id}-reply`, parts }] : [],
  };
}
