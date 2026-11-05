import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createMemberGatewayHandler } from '../src/member-gateway.js';

test('shared gateway reuses only its schema engine; request servers and current policy stay separate', async (t) => {
  const engines = new Set<unknown>();
  const servers = new Set<Server>();
  const originalConnect = Server.prototype.connect;
  t.mock.method(Server.prototype, 'connect', function (this: Server, transport: Transport) {
    servers.add(this);
    // SDK's public constructor option owns this allocation. Observe the real
    // engine selected at connect, rather than mocking the gateway's factory.
    const engine = (this as unknown as { _jsonSchemaValidator: { getValidator?: unknown } })._jsonSchemaValidator;
    assert.equal(typeof engine?.getValidator, 'function', 'the allocation observer must see a real SDK engine');
    engines.add(engine);
    return originalConnect.call(this, transport);
  });
  let restricted = false;
  const makeHandler = () =>
    createMemberGatewayHandler({
      verify: async ({ invocationId, callbackToken }) => ({
        ok: true,
        context: {
          invocationId,
          callbackToken,
          catId: 'fixture',
          threadId: invocationId,
          userId: 'fixture',
          apiBaseUrl: 'http://127.0.0.1:1',
          toolsetEnv: { allowedToolNames: restricted ? [] : ['cat_cafe_read_file_slice'] },
          sharedContext: {
            v: 1,
            deploymentId: 'fixture',
            workspaceRoot: tmpdir(),
            dataDir: tmpdir(),
            capabilityRoot: tmpdir(),
            allowedWorkspaceDirs: [tmpdir()],
            families: ['memory'],
          },
        },
      }),
      resolveFamilies: () => ['memory'],
    });
  let handler = makeHandler();
  const http = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    await handler(req, res, JSON.parse(body));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  t.after(
    () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  );
  const request = async (id: string, method: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp?shared=1&family=memory`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-03-26',
        'x-invocation-id': id,
        'x-callback-token': 'owned-fixture',
        'x-mcp-connection-id': id,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params:
          method === 'initialize'
            ? {
                protocolVersion: '2025-03-26',
                capabilities: {},
                clientInfo: { name: 'schema-allocation', version: '1' },
              }
            : {},
      }),
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ result?: { tools: Array<{ name: string }> }; error?: { code: number } }>;
  };
  await request('A', 'initialize');
  const allowed = await request('A', 'tools/list');
  assert.ok(allowed.result);
  assert.deepEqual(
    allowed.result.tools.map((tool: { name: string }) => tool.name),
    ['cat_cafe_read_file_slice'],
  );
  restricted = true;
  await request('B', 'initialize');
  const denied = await request('B', 'tools/list');
  assert.ok(denied.error);
  assert.equal(denied.error.code, -32601, "a server with no tools cannot retain A's tools capability for B");
  assert.equal(servers.size, 4, 'each request still owns a separate protocol server and handlers');
  assert.equal(engines.size, 1, 'one immutable schema engine per shared gateway, not per POST');
  handler = makeHandler();
  await request('C', 'initialize');
  assert.equal(engines.size, 2, 'separate gateways do not share retained state');
});
