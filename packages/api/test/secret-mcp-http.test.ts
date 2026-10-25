import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { guardMcpConfig } from '../src/config/capabilities/secret-mcp-config.js';

for (const kind of ['http', 'sse', 'auto-http', 'auto-sse', 'env-http'])
  test(`real ${kind} MCP relay preserves auth, blocks input and redacts results`, { timeout: 15000 }, async () => {
    const fake = ['ghp', '_', 'Y'.repeat(36)].join('');
    let executions = 0;
    const notices: Array<{ body: string; invocation?: string }> = [];
    const mcp = new McpServer({ name: 'remote-fixture', version: '1' });
    mcp.registerTool('browser_input', { inputSchema: { text: z.string() } }, async ({ text }) => {
      executions++;
      return { content: [{ type: 'text', text: text === 'expose' ? fake : text }] };
    });
    let sse: SSEServerTransport | undefined;
    const http = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    const isHttp = kind.endsWith('http');
    if (isHttp) await mcp.connect(http);
    const api = createServer(async (req, res) => {
      if (req.url === '/api/callbacks/post-message') {
        let body = '';
        for await (const chunk of req) body += chunk;
        notices.push({ body, invocation: req.headers['x-invocation-id'] as string });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messageId: 'notice' }));
      } else if (
        req.headers['x-fixture-auth'] !== 'transport-owned' ||
        (kind === 'env-http' && req.headers.authorization !== 'Bearer transport-owned')
      ) {
        res.writeHead(401).end();
      } else if (isHttp) {
        await http.handleRequest(req, res);
      } else if (req.method === 'GET') {
        sse = new SSEServerTransport('/messages', res);
        await mcp.connect(sse);
      } else if (sse) {
        await sse.handlePostMessage(req, res);
      } else res.writeHead(405).end();
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const address = api.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const config = guardMcpConfig(
      {
        url: `${url}/mcp`,
        type: kind.startsWith('auto-') ? 'auto' : kind === 'env-http' ? 'http' : kind,
        headers: { 'x-fixture-auth': 'transport-owned' },
        ...(kind === 'env-http'
          ? { bearer_token_env_var: 'NODE_OPTIONS', env: { NODE_OPTIONS: 'transport-owned' } }
          : {}),
      },
      { CAT_CAFE_API_URL: url, CAT_CAFE_INVOCATION_ID: 'remote-invocation', CAT_CAFE_CALLBACK_TOKEN: 'fixture' },
    );
    assert.equal(
      (config.env as Record<string, string>).NODE_OPTIONS,
      undefined,
      'transport values cannot configure Node',
    );
    const client = new Client({ name: 'remote-consumer', version: '1' });
    const transport = new StdioClientTransport({
      command: String(config.command),
      args: config.args as string[],
      env: config.env as Record<string, string>,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools[0].name, 'browser_input');
      await client.callTool({ name: 'browser_input', arguments: { text: 'clean' } });
      assert.equal(executions, 1);
      const blocked = await client.callTool({ name: 'browser_input', arguments: { text: fake } });
      assert.equal(blocked.isError, true);
      assert.equal(executions, 1);
      assert.equal(notices.length, 0, 'pre-send blocking must not claim exposure');
      const exposed = await client.callTool({ name: 'browser_input', arguments: { text: 'expose' } });
      assert.ok(!JSON.stringify(exposed).includes(fake));
      assert.equal(notices.length, 1);
      assert.equal(notices[0].invocation, 'remote-invocation');
      assert.ok(!notices[0].body.includes(fake));
    } finally {
      await client.close();
      await mcp.close();
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
    }
  });
