import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMemberGatewayHandler } from '../src/member-gateway.js';
import { SHARED_MCP_FAMILIES } from '../src/shared-invocation-context.js';

test('all six shared families execute under their original owner; live policy and display never come from another request', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shared-family-calls-'));
  let apiUrl = '';
  const observed = new Set<string>();
  let restricted = false;
  let display = 'First Fixture';
  const handler = createMemberGatewayHandler({
    verify: async ({ invocationId, callbackToken }) => ({
      ok: true,
      context: {
        invocationId,
        callbackToken,
        catId: `cat-${invocationId}`,
        userId: `user-${invocationId}`,
        threadId: `thread-${invocationId}`,
        apiBaseUrl: apiUrl,
        toolsetEnv: restricted ? { allowedToolNames: ['cat_cafe_read_file_slice'] } : {},
        sharedContext: {
          v: 1,
          deploymentId: 'fixture',
          workspaceRoot: join(root, invocationId),
          dataDir: root,
          capabilityRoot: root,
          allowedWorkspaceDirs: [join(root, invocationId)],
          families: SHARED_MCP_FAMILIES,
        },
      },
    }),
    resolveFamilies: () => SHARED_MCP_FAMILIES,
  });
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (req.url?.startsWith('/mcp')) {
        void handler(req, res, JSON.parse(raw));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/config') {
        res.end(JSON.stringify({ config: { coCreator: { name: display, mentionPatterns: ['@fixture'] } } }));
        return;
      }
      const owner = req.headers['x-invocation-id'] ?? String(req.headers['x-cat-cafe-user']).replace(/^user-/, '');
      assert.ok(owner === 'A' || owner === 'B');
      if (req.headers['x-invocation-id']) assert.equal(req.headers['x-callback-token'], `fixture-token-${owner}`);
      observed.add(`${owner}:${req.url?.split('?')[0]}`);
      res.end(JSON.stringify({ owner, threads: [], items: [], nodes: [], apps: [], mics: [] }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  apiUrl = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.FRED_API_KEY;
  process.env.FRED_API_KEY = 'fixture-fred-key';
  t.mock.method(globalThis, 'fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.stlouisfed.org') {
      assert.equal(url.searchParams.get('api_key'), 'fixture-fred-key');
      observed.add(`finance:${url.searchParams.get('series_id')}`);
      return Promise.resolve(new Response(JSON.stringify({ observations: [{ date: '2026-10-25', value: '12.5' }] })));
    }
    return originalFetch(input, init);
  });
  const rpc = async (owner: string, family: string, method: string, params: unknown) => {
    const response = await fetch(`${apiUrl}/mcp?shared=1&family=${family}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-invocation-id': owner,
        'x-callback-token': `fixture-token-${owner}`,
        'x-mcp-connection-id': `connection-${owner}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    for (const owner of ['A', 'B']) {
      mkdirSync(join(root, owner));
      writeFileSync(join(root, owner, 'document.txt'), `document ${owner}`);
      const cases = [
        ['collab', 'cat_cafe_list_threads', {}],
        ['memory', 'cat_cafe_read_file_slice', { path: 'document.txt', startLine: 1 }],
        ['signals', 'signal_list_inbox', {}],
        ['limb', 'limb_list_available', {}],
        ['audio', 'cat_cafe_audio_list_sources', {}],
        ['finance', 'cat_cafe_finance_query', { provider: 'fred', fred: { seriesId: `FIXTURE_${owner}` } }],
      ] as const;
      for (const [family, name, args] of cases) {
        const body = await rpc(owner, family, 'tools/call', { name, arguments: args });
        assert.ok(body.result && !body.result.isError, JSON.stringify(body));
        if (family === 'memory') assert.ok(JSON.stringify(body.result).includes(`document ${owner}`));
      }
      for (const endpoint of [
        '/api/callbacks/list-threads',
        '/api/signals/inbox',
        '/api/callback/limb/list',
        '/api/audio/sources',
      ])
        assert.ok(observed.has(`${owner}:${endpoint}`));
      assert.ok(observed.has(`finance:FIXTURE_${owner}`));
    }
    const first = JSON.stringify(await rpc('A', 'collab', 'tools/list', {}));
    assert.ok(first.includes(display));
    display = 'Second Fixture';
    const second = JSON.stringify(await rpc('B', 'collab', 'tools/list', {}));
    assert.ok(second.includes(display));
    assert.ok(!second.includes('First Fixture'));
    restricted = true;
    const restrictedList = await rpc('A', 'collab', 'tools/list', {});
    assert.deepEqual(restrictedList.result?.tools ?? [], [], 'a cached schema is not a cached grant');
    if (restrictedList.error)
      assert.equal(restrictedList.error.code, -32601, 'an empty surface offers no tools capability');
    const denied = await rpc('A', 'collab', 'tools/call', { name: 'cat_cafe_list_threads', arguments: {} });
    assert.ok(denied.error || denied.result?.isError);
  } finally {
    t.mock.restoreAll();
    if (oldKey === undefined) delete process.env.FRED_API_KEY;
    else process.env.FRED_API_KEY = oldKey;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
});
