import { describe, expect, it } from 'vitest';
import { runDeepAgent, type AgentDef, type Llm, type LlmMessage, type Memory, type ChatTurn, type Todo } from '../src';

function memory() {
  const turns: ChatTurn[] = [];
  let plan: Todo[] = [];
  const m: Memory = { load: async () => [...turns], append: async (_s, t) => void turns.push(t), savePlan: async (_s, p) => void (plan = p) };
  return { m, turns, plan: () => plan };
}

const ctx = { tenantId: 't', sessionId: 's', channel: 'test', customerId: null, a2ui: true };

const priceTool = {
  name: 'price',
  description: 'price a thing',
  parameters: { type: 'object' },
  run: async (a: Record<string, unknown>) => ({ data: { price: 42, item: a.item }, say: `It costs 42.`, ui: [{ version: 'v1.0', deleteSurface: { surfaceId: 'x' } } as any] }),
};

/** Scripted model: plans, delegates to the specialist, which calls a tool, then answers. */
function scriptedLlm(): Llm {
  return {
    name: 'scripted',
    async chat(messages: LlmMessage[], tools) {
      const names = tools.map((t) => t.function.name);
      const last = messages.at(-1)!;
      if (names.includes('delegate')) {
        if (last.role === 'user') return { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'write_todos', arguments: JSON.stringify({ todos: [{ content: 'ask shop', status: 'in_progress' }] }) } }] };
        if (last.role === 'tool' && last.tool_call_id === '1') return { role: 'assistant', content: null, tool_calls: [{ id: '2', type: 'function', function: { name: 'delegate', arguments: JSON.stringify({ agent: 'shop', task: 'price of shoes' }) } }] };
        return { role: 'assistant', content: `Done: ${last.content}` };
      }
      if (last.role === 'user') return { role: 'assistant', content: null, tool_calls: [{ id: '3', type: 'function', function: { name: 'price', arguments: '{"item":"shoes"}' } }] };
      return { role: 'assistant', content: 'Shoes cost 42.' };
    },
  };
}

const shop: AgentDef = { id: 'shop', name: 'Shop', description: 'prices', instructions: 'price things', tools: [priceTool] };
const top: AgentDef = { id: 'top', name: 'Top', description: 'concierge', instructions: 'help', tools: [], subagents: [shop] };

describe('deep agent runtime', () => {
  it('plans, delegates to a sub-agent, bubbles tool calls and UI up, remembers the turn', async () => {
    const mem = memory();
    const r = await runDeepAgent(top, { sessionId: 's', text: 'how much are shoes?' }, ctx, { llm: scriptedLlm(), memory: mem.m });
    expect(r.reply).toContain('Shoes cost 42.');
    expect(r.toolCalls.map((c) => `${c.agent}:${c.name}`)).toEqual(['shop:price']);
    expect(r.ui).toHaveLength(1);
    expect(mem.plan()).toEqual([{ content: 'ask shop', status: 'in_progress' }]);
    expect(mem.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
  });

  it('routes UI actions straight to the named tool without a model', async () => {
    const mem = memory();
    const r = await runDeepAgent(top, { sessionId: 's', action: { name: 'price', surfaceId: 's', sourceComponentId: 'b', timestamp: '', context: { item: 'hat' } } }, ctx, { llm: null, memory: mem.m });
    expect(r.engine).toBe('action');
    expect((r.toolCalls[0]!.result as any).item).toBe('hat');
  });

  it('falls back to deterministic specialists offline', async () => {
    const withFallback: AgentDef = {
      ...top,
      subagents: [{ ...shop, fallback: async ({ text, call }) => (/shoes/.test(text) ? { reply: (await call('price', {})).say!, ui: [], toolCalls: [] } : null) }],
    };
    const r = await runDeepAgent(withFallback, { sessionId: 's', text: 'shoes please' }, ctx, { llm: null, memory: memory().m });
    expect(r.engine).toBe('rules');
    expect(r.reply).toBe('It costs 42.');
    expect(r.toolCalls).toHaveLength(1);
  });
});
