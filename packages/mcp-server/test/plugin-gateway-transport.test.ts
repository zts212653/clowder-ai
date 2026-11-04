import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMemberGatewayHandler, type MemberGatewayDeps } from '../src/member-gateway.js';

test('the existing gateway transports only the request-owned package server and closes it', async () => {
  let opened = 0;
  let closed = 0;
  const handler = createMemberGatewayHandler({
    verify: async () => ({
      ok: true,
      context: {
        invocationId: 'inv',
        callbackToken: 'token',
        catId: 'cat',
        userId: 'user',
        threadId: 'thread',
        apiBaseUrl: 'http://127.0.0.1:1',
        toolsetEnv: {},
        sharedContext: {
          v: 1,
          deploymentId: 'test',
          workspaceRoot: '/tmp',
          capabilityRoot: '/tmp',
          dataDir: '/tmp',
          allowedWorkspaceDirs: ['/tmp'],
          families: [],
        },
      },
    }),
    resolveFamilies: () => [],
    createMcpServer: async () => {
      opened++;
      const server = new McpServer({ name: 'package-owned', version: '1' });
      server.tool('package_tool', {}, async () => ({ content: [{ type: 'text', text: 'package response' }] }));
      const close = server.close.bind(server);
      server.close = async () => {
        closed++;
        await close();
      };
      return server;
    },
  } as MemberGatewayDeps);
  const http = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    await handler(req, res, JSON.parse(body));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/plugin-mcp/instance/ordinary?shared=1&activation=revision`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-invocation-id': 'inv',
          'x-callback-token': 'token',
          'x-mcp-connection-id': 'connection',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
    );
    const body = await response.json();
    assert.deepEqual(
      body.result?.tools?.map((t: { name: string }) => t.name),
      ['package_tool'],
    );
    assert.equal(opened, 1);
    assert.equal(closed, 1);
  } finally {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
