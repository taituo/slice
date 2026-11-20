import type { A2uiAction, A2uiServerMessage } from '@slice/shared';

/**
 * Deep-agent runtime shared by every customer-facing agent (chat, A2A, voice, MCP-adjacent) and by
 * the development agents. "Deep" = the agent plans (write_todos), delegates to specialised
 * sub-agents (delegate), remembers the conversation across channels (memory), and returns
 * A2UI surfaces next to text. No DB or HTTP knowledge here: tools and memory are injected.
 */

export interface ToolContext {
  tenantId: string;
  sessionId: string;
  channel: string;
  customerId: string | null;
  location?: { lat: number; lng: number; addressLine?: string };
  a2ui: boolean;
}

export interface ToolResult {
  data: unknown;
  ui?: A2uiServerMessage[];
  /** Short sentence a deterministic path can say about the result. */
  say?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolCallRecord {
  agent: string;
  name: string;
  args: unknown;
  result: unknown;
}

export interface AgentReply {
  reply: string;
  ui: A2uiServerMessage[];
  toolCalls: ToolCallRecord[];
}

export interface FallbackTurn {
  text: string;
  history: ChatTurn[];
  ctx: ToolContext;
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface AgentDef {
  id: string;
  name: string;
  /** What the parent agent reads when deciding whom to delegate to. */
  description: string;
  instructions: string;
  tools: ToolSpec[];
  subagents?: AgentDef[];
  /** Deterministic behaviour for offline mode and CI; return null to pass. */
  fallback?: (turn: FallbackTurn) => Promise<AgentReply | null>;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface Memory {
  load(sessionId: string): Promise<ChatTurn[]>;
  append(sessionId: string, turn: ChatTurn, data?: unknown): Promise<void>;
  savePlan(sessionId: string, plan: Todo[]): Promise<void>;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface Llm {
  readonly name: string;
  chat(messages: LlmMessage[], tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>): Promise<LlmMessage>;
}

export interface RunInput {
  sessionId: string;
  text?: string;
  /** A2UI button press etc. Routed straight to the tool of the same name — no model round-trip. */
  action?: A2uiAction;
}

export interface RunResult extends AgentReply {
  sessionId: string;
  engine: string;
  plan: Todo[];
}

/** OpenAI-compatible chat completions client (DeepSeek by default; any compatible endpoint works). */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): Llm | null {
  const apiKey = env.LLM_API_KEY ?? env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  const baseUrl = env.LLM_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
  const model = env.LLM_MODEL ?? env.DEEPSEEK_MODEL ?? 'deepseek-chat';
  return {
    name: model,
    async chat(messages, tools) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, tools: tools.length ? tools : undefined, temperature: 0.3 }),
      });
      if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { choices: Array<{ message: LlmMessage }> };
      return data.choices[0]!.message;
    },
  };
}

function allTools(def: AgentDef): Map<string, { tool: ToolSpec; agent: string }> {
  const out = new Map<string, { tool: ToolSpec; agent: string }>();
  const walk = (d: AgentDef) => {
    for (const t of d.tools) if (!out.has(t.name)) out.set(t.name, { tool: t, agent: d.id });
    for (const s of d.subagents ?? []) walk(s);
  };
  walk(def);
  return out;
}

const PLAN_TOOL = {
  type: 'function' as const,
  function: {
    name: 'write_todos',
    description: 'Write or update your plan for a multi-step request. Keep it short; mark items done as you go.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
};

function delegateTool(subagents: AgentDef[]) {
  return {
    type: 'function' as const,
    function: {
      name: 'delegate',
      description: `Hand a self-contained task to a specialist and get its answer back. Specialists: ${subagents
        .map((s) => `${s.id} (${s.description})`)
        .join('; ')}`,
      parameters: {
        type: 'object',
        properties: { agent: { type: 'string', enum: subagents.map((s) => s.id) }, task: { type: 'string' } },
        required: ['agent', 'task'],
      },
    },
  };
}

/** One model-driven agent loop (used for the top agent and, recursively, for sub-agents). */
async function llmLoop(def: AgentDef, llm: Llm, convo: LlmMessage[], ctx: ToolContext, plan: Todo[], depth: number): Promise<AgentReply> {
  const toolCalls: ToolCallRecord[] = [];
  const ui: A2uiServerMessage[] = [];
  const tools = [
    ...def.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
    PLAN_TOOL,
    ...(def.subagents?.length && depth < 2 ? [delegateTool(def.subagents)] : []),
  ];
  for (let round = 0; round < 8; round++) {
    const msg = await llm.chat(convo, tools);
    convo.push(msg);
    if (!msg.tool_calls?.length) return { reply: msg.content ?? '', ui, toolCalls };
    for (const call of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        /* invalid JSON from the model: the tool's validation reports it */
      }
      let result: unknown;
      try {
        if (call.function.name === 'write_todos') {
          plan.splice(0, plan.length, ...((args.todos as Todo[]) ?? []));
          result = { ok: true };
        } else if (call.function.name === 'delegate') {
          const sub = def.subagents?.find((s) => s.id === args.agent);
          if (!sub) throw new Error(`No such specialist: ${String(args.agent)}`);
          const subConvo: LlmMessage[] = [
            { role: 'system', content: `${sub.instructions}\n${contextNote(ctx)}` },
            { role: 'user', content: String(args.task ?? '') },
          ];
          const r = await llmLoop(sub, llm, subConvo, ctx, plan, depth + 1);
          toolCalls.push(...r.toolCalls);
          ui.push(...r.ui);
          result = { answer: r.reply };
        } else {
          const tool = def.tools.find((t) => t.name === call.function.name);
          if (!tool) throw new Error(`Unknown tool ${call.function.name}`);
          const r = await tool.run(args, ctx);
          if (r.ui) ui.push(...r.ui);
          result = r.data;
          toolCalls.push({ agent: def.id, name: tool.name, args, result });
        }
      } catch (err) {
        result = { error: (err as Error).message };
      }
      convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12_000) });
    }
  }
  return { reply: 'That took too many steps. Could you rephrase?', ui, toolCalls };
}

function contextNote(ctx: ToolContext): string {
  return [
    ctx.location ? `Customer location: ${ctx.location.lat}, ${ctx.location.lng}${ctx.location.addressLine ? ` (${ctx.location.addressLine})` : ''}.` : '',
    ctx.customerId ? 'The customer is signed in: never ask for name or phone.' : '',
    `Channel: ${ctx.channel}.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Deterministic fallback chain: the agent's own fallback, then each sub-agent's. */
async function fallbackChain(def: AgentDef, turn: Omit<FallbackTurn, 'call'>, toolCalls: ToolCallRecord[]): Promise<AgentReply | null> {
  const tools = allTools(def);
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = tools.get(name);
    if (!t) throw new Error(`Unknown tool ${name}`);
    const r = await t.tool.run(args, turn.ctx);
    toolCalls.push({ agent: t.agent, name, args, result: r.data });
    return r;
  };
  const order = [def, ...(def.subagents ?? [])];
  for (const d of order) {
    if (!d.fallback) continue;
    const r = await d.fallback({ ...turn, call });
    if (r) return { ...r, toolCalls: [...toolCalls, ...r.toolCalls] };
  }
  return null;
}

export async function runDeepAgent(def: AgentDef, input: RunInput, ctx: ToolContext, deps: { llm: Llm | null; memory: Memory }): Promise<RunResult> {
  const history = await deps.memory.load(input.sessionId);
  const plan: Todo[] = [];

  // 1. UI actions go straight to the tool they name.
  if (input.action) {
    const t = allTools(def).get(input.action.name);
    if (!t) throw new Error(`Unknown action ${input.action.name}`);
    const r = await t.tool.run(input.action.context, ctx);
    const reply = r.say ?? 'Done.';
    await deps.memory.append(input.sessionId, { role: 'user', content: input.action.userMessage ?? `[${input.action.name}]` }, { action: input.action });
    await deps.memory.append(input.sessionId, { role: 'assistant', content: reply });
    return {
      sessionId: input.sessionId,
      engine: 'action',
      plan,
      reply,
      ui: r.ui ?? [],
      toolCalls: [{ agent: t.agent, name: input.action.name, args: input.action.context, result: r.data }],
    };
  }

  const text = input.text ?? '';
  await deps.memory.append(input.sessionId, { role: 'user', content: text });
  let result: AgentReply;
  let engine: string;
  if (deps.llm) {
    const convo: LlmMessage[] = [
      { role: 'system', content: `${def.instructions}\n${contextNote(ctx)}` },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: text },
    ];
    result = await llmLoop(def, deps.llm, convo, ctx, plan, 0);
    engine = deps.llm.name;
  } else {
    const toolCalls: ToolCallRecord[] = [];
    result = (await fallbackChain(def, { text, history, ctx }, toolCalls)) ?? {
      reply: `I can help with: ${(def.subagents ?? [def]).map((s) => s.description).join('; ')}. What would you like?`,
      ui: [],
      toolCalls,
    };
    engine = 'rules';
  }
  if (plan.length) await deps.memory.savePlan(input.sessionId, plan);
  await deps.memory.append(input.sessionId, { role: 'assistant', content: result.reply }, { toolCalls: result.toolCalls.map((c) => c.name) });
  return { ...result, sessionId: input.sessionId, engine, plan };
}
