import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test('an owner-approved extension uses the original shared MCP connection and preserves Host tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shared-mcp-'));
  const original = { ...process.env };
  const key = 'b'.repeat(64);
  const keyFile = join(directory, 'pro.key');
  await writeFile(keyFile, key, { mode: 0o600 });
  let publishedTool = 'fixture_read';
  const seen: Array<{ path: string; key: unknown; invocation: unknown; method: string }> = [];
  const host = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ config: { coCreator: { name: 'Nora', mentionPatterns: ['@nora'] } } }));
      return;
    }
    assert.equal(req.url, '/api/plugin-runtime/shared/handle');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({
      path: req.url!,
      key: req.headers['x-agent-key-secret'],
      invocation: req.headers['x-invocation-id'],
      method: rpc.method,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result:
          rpc.method === 'tools/list'
            ? {
                resultType: 'complete',
                tools: [{ name: publishedTool, description: 'Approved fixture tool', inputSchema: { type: 'object' } }],
              }
            : rpc.method === 'events/list'
              ? {
                  resultType: 'complete',
                  events: [
                    {
                      name: 'fixture.changed',
                      description: 'Approved fixture event',
                      argumentsSchema: { type: 'object' },
                    },
                  ],
                }
              : { content: [{ type: 'text', text: 'source-bound' }], isError: false },
      }),
    );
  });
  const api = await listen(host);
  Object.assign(process.env, {
    CAT_CAFE_REMOTE_TOKEN: 'existing-token',
    CAT_CAFE_DESKTOP_MODE: 'cloud-pro-phase0',
    CAT_CAFE_READONLY: 'true',
    CAT_CAFE_CAT_ID: 'gpt-pro',
    CAT_CAFE_USER_ID: 'owner',
    CAT_CAFE_API_URL: api,
    CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ 'gpt-pro': keyFile }),
    CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'gpt-pro',
  });
  delete process.env.CAT_CAFE_INVOCATION_ID;
  delete process.env.CAT_CAFE_CALLBACK_TOKEN;
  delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
  const { handleMcpRequest } = await import('../src/remote-spike.js');
  const remote = createServer((req, res) => void handleMcpRequest(req, res));
  const url = await listen(remote);
  const rpc = async (
    method: string,
    params = {},
    suffix = '?token=existing-token',
    version = '2026-07-28',
    accept = 'application/json',
  ) => {
    const response = await fetch(`${url}/mcp${suffix}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept,
        'mcp-protocol-version': version,
        'x-agent-key-secret': 'caller-forged',
        'x-invocation-id': 'caller-invocation',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: JSON.parse(text.startsWith('event:') ? text.split('data: ')[1]!.trim() : text),
    };
  };
  try {
    const discovery = await rpc('server/discover');
    assert.equal(discovery.status, 200);
    assert.deepEqual(discovery.body.result?.supportedVersions, ['2026-07-28', '2025-11-25']);
    const modern = await rpc('initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'dot', version: '1' },
    });
    assert.equal(modern.body.result.protocolVersion, '2026-07-28');
    assert.deepEqual(modern.body.result.capabilities.events, {});
    assert.equal((await rpc('initialize', { protocolVersion: '2026-07-28' })).body.error.code, -32602);
    const legacy = await rpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'pro', version: '1' },
    });
    assert.equal(legacy.body.result.protocolVersion, '2025-11-25');
    const catalog = await rpc('tools/list');
    assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
    const names = catalog.body.result.tools.map((tool: { name: string }) => tool.name);
    assert.equal(names.length, new Set(names).size, 'tools must not be registered twice');
    assert.equal(
      (await rpc('tools/list', {}, '?token=existing-token', '2025-11-25', 'application/json, text/event-stream')).body
        .result.tools.length,
      names.length,
    );
    assert.equal(
      (await rpc('tools/list', {}, '?token=existing-token', '2027-01-01', 'application/json, text/event-stream'))
        .status,
      400,
    );
    for (const name of ['cat_cafe_post_message', 'cat_cafe_get_thread_context', 'cat_cafe_search_evidence'])
      assert.ok(names.includes(name), name);
    assert.ok(names.includes('fixture_read'), 'approved plugin tools must remain available through the original /mcp');
    const events = await rpc('events/list');
    assert.equal(events.status, 200);
    assert.ok(events.body.result.events.some((event: { name: string }) => event.name === 'fixture.changed'));
    const called = await rpc('tools/call', { name: 'fixture_read', arguments: {} });
    assert.equal(called.body.result.content[0].text, 'source-bound');
    assert.ok(seen.some((item) => item.method === 'tools/call'));
    assert.ok(
      seen.every((item) => item.key === key && item.invocation === undefined),
      'only the existing server-bound AgentKey reaches Host; client-forged identity never does',
    );
    publishedTool = 'cat_cafe_post_message';
    const conflictedCatalog = await rpc('tools/list');
    const conflictedNames = conflictedCatalog.body.result.tools.map((tool: { name: string }) => tool.name);
    assert.equal(
      conflictedNames.filter((name: string) => name === publishedTool).length,
      1,
      'a conflicting extension surface is rejected before it can shadow a Host tool',
    );
    const beforeUnauthorized = seen.length;
    assert.equal((await rpc('events/list', {}, '')).status, 401);
    assert.equal(seen.length, beforeUnauthorized, 'outer authentication rejects before reaching Host');
    // R12's single-entry map remains the identity boundary for the Pro process itself.
    const { validateB1aEnv } = await import('../src/remote-spike.js');
    process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ 'gpt-pro': keyFile, 'gpt-dot': keyFile });
    assert.throws(() => validateB1aEnv(), /extra cats/);
  } finally {
    await close(remote);
    await close(host);
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await rm(directory, { recursive: true, force: true });
  }
});
