import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server';

/**
 * Remote MCP over Streamable HTTP (stateless) at POST /mcp — the form ChatGPT connectors and hosted
 * Claude connectors use. Put it behind the same gateway/OAuth as the public API in production.
 */
const port = Number(process.env.MCP_PORT ?? 4100);

const httpServer = createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    return;
  }
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    res.writeHead(400).end('invalid json');
    return;
  }
  // "Connect your assistant": the assistant's bearer token is forwarded so tools act for that person.
  const auth = req.headers.authorization;
  const server = createMcpServer({ token: auth?.startsWith('Bearer sk_') ? auth.slice(7) : undefined });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
});

httpServer.listen(port, () => console.log(`MCP server on http://localhost:${port}/mcp`));
