import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SliceClient, toolCatalog, type AgentToolName } from '@slice/shared';

/**
 * MCP server: lets ChatGPT, Claude, or any MCP client use the whole platform — competing offers,
 * food, gym classes, nearby shops, support. Every tool proxies to the same REST tool endpoint the
 * agents use. A bearer token from "connect your assistant" makes the tools act for that person
 * (no name/phone needed, scopes enforced, revocable).
 */
export function createMcpServer(opts: { apiUrl?: string; token?: string; tenant?: string } = {}) {
  const api = new SliceClient(opts.apiUrl ?? process.env.API_URL ?? 'http://localhost:4000', { token: opts.token, tenant: opts.tenant ?? process.env.MCP_TENANT ?? 'nearby' });
  const server = new McpServer({ name: 'slice-platform', version: '0.2.0' });

  for (const name of Object.keys(toolCatalog) as AgentToolName[]) {
    const tool = toolCatalog[name];
    server.registerTool(
      name,
      {
        description: tool.description,
        inputSchema: tool.input.shape,
        annotations: {
          readOnlyHint: !['place_order', 'cancel_order', 'choose_offer', 'book_class', 'cancel_booking', 'open_support_case'].includes(name),
          destructiveHint: ['cancel_order', 'cancel_booking'].includes(name),
        },
      },
      async (args: unknown) => {
        try {
          const r = await api.callTool(name, args as Record<string, unknown>);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ summary: r.say, data: r.data }, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text' as const, text: (err as Error).message }] };
        }
      },
    );
  }

  server.registerResource('menu', 'slice://menu', { title: 'Pizza menu', mimeType: 'application/json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify((await api.menu()).items) }],
  }));
  return server;
}
