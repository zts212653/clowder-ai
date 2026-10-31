import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCollabToolset } from '../src/server-toolsets.js';

test('SDK metadata gates registered tools before transport and keeps credentials outside model arguments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'f317-registered-'));
  const file = join(dir, 'projection.json');
  const vars = {
    CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE: file,
    CAT_CAFE_NATIVE_CONNECTION_ID: 'connection',
    CAT_CAFE_API_URL: 'http://127.0.0.1:49999',
    CAT_CAFE_DESKTOP_MODE: 'live-companion',
  };
  const isolatedKeys = [
    ...Object.keys(vars),
    'CAT_CAFE_MCP_PROFILE',
    'CAT_CAFE_READONLY',
    'CAT_CAFE_AGENT_KEY_SECRET',
    'CAT_CAFE_AGENT_KEY_FILE',
    'CAT_CAFE_AGENT_KEY_FILES',
    'CAT_CAFE_READONLY_AGENT_KEY_UNION',
  ];
  const previous = Object.fromEntries(isolatedKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  const server = new McpServer({ name: 'f317', version: '1' });
  const client = new Client({ name: 'synthetic', version: '1' });
  try {
    for (const key of isolatedKeys) delete process.env[key];
    Object.assign(process.env, vars);
    await writeFile(
      file,
      JSON.stringify({
        v: 1,
        connectionId: 'connection',
        nativeThreadId: 'native',
        turns: [{ nativeTurnId: 'turn', invocationId: 'admitted', callbackToken: 'private-token' }],
      }),
      { mode: 0o600 },
    );
    globalThis.fetch = async (url, init) => {
      paths.push(new URL(String(url)).pathname);
      assert.equal(new Headers(init?.headers).get('x-invocation-id'), 'admitted');
      assert.equal(new Headers(init?.headers).get('x-callback-token'), 'private-token');
      if (paths.at(-1) === '/api/callbacks/native-turn-admission') return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ threadId: 'owned', cats: [] }));
    };
    registerCollabToolset(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const meta = { threadId: 'native', 'x-codex-turn-metadata': { thread_id: 'native', turn_id: 'turn' } };
    const call = { name: 'cat_cafe_get_thread_cats', arguments: { threadId: 'owned' } };
    assert.equal((await client.callTool({ ...call, arguments: { ...call.arguments, _meta: meta } })).isError, true);
    assert.deepEqual(paths, []);
    const result = await client.callTool({ ...call, _meta: meta });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual(paths, ['/api/callbacks/native-turn-admission', '/api/callbacks/thread-cats']);
    assert.ok(!JSON.stringify(result).includes('private-token'));
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
