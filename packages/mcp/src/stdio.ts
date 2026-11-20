#!/usr/bin/env -S npx tsx
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server';

/** Local MCP (Claude Desktop, Cursor, etc.): `npx tsx packages/mcp/src/stdio.ts` with API_URL set. */
async function main() {
  const server = createMcpServer({ token: process.env.SLICE_ASSISTANT_TOKEN });
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
