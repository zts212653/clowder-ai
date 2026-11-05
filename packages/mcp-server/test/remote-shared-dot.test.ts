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

test('one installed MCP URL discovers dot events and tools while preserving Pro default tools and bound auth', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shared-mcp-'));
  const original = { ...process.env };
  const key = 'b'.repeat(64);
  const keyFile = join(directory, 'pro.key');
  await writeFile(keyFile, key, { mode: 0o600 });
  const seen: Array<{ path: string; key: unknown; invocation: unknown; method: string }> = [];
  const host = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ config: { coCreator: { name: 'Nora', mentionPatterns: ['@nora'] } } }));
      return;
    }
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
          rpc.method === 'events/list'
            ? { events: [{ name: 'dot.summoned' }] }
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
    assert.ok(modern.body.result.capabilities.events);
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
    for (const name of [
      'cat_cafe_post_message',
      'cat_cafe_get_thread_context',
      'cat_cafe_search_evidence',
      'cat_cafe_dot_read_source',
      'cat_cafe_dot_reply',
      'cat_cafe_dot_publish_image',
      'cat_cafe_dot_ask',
    ])
      assert.ok(names.includes(name), name);
    assert.equal((await rpc('events/list')).body.result.events[0].name, 'dot.summoned');
    assert.equal(
      (
        await rpc('tools/call', {
          name: 'cat_cafe_dot_read_source',
          arguments: { event_id: `dot_evt_${'a'.repeat(64)}` },
        })
      ).body.result.isError,
      false,
    );
    assert.ok(
      seen.every((item) => item.path === '/api/plugins/chatgpt-dot/shared-mcp' && item.key === key && !item.invocation),
    );
    const beforeSelector = seen.length;
    const forged = await rpc('tools/call', {
      name: 'cat_cafe_dot_read_source',
      arguments: { event_id: `dot_evt_${'a'.repeat(64)}`, catId: 'gpt-pro' },
    });
    assert.ok(forged.body.result?.isError || forged.body.error);
    assert.equal(seen.length, beforeSelector, 'caller-selected actors are refused before Host dispatch');
    const before = seen.length;
    assert.equal((await rpc('events/list', {}, '')).status, 401);
    assert.equal(seen.length, before);
    // R12's single-entry map remains the identity boundary, even for shared discovery.
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
