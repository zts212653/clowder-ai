import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { handlePluginRemoteRequest } from '../src/plugin-remote-proxy.js';

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

test('the public listener forwards one installation token to the fixed Host port; selectors and caller headers never cross', async () => {
  const seen: Array<{
    path: string;
    auth: string | undefined;
    agent: string | string[] | undefined;
    pluginHeader: string | string[] | undefined;
  }> = [];
  const host = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain the bounded request */
    }
    seen.push({
      path: req.url!,
      auth: req.headers.authorization,
      agent: req.headers['x-agent-key-secret'],
      pluginHeader: req.headers['x-plugin-id'],
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
  });
  const api = await listen(host);
  const remote = createServer((req, res) => void handlePluginRemoteRequest(req, res, api));
  const endpoint = await listen(remote);
  const key = `cpa_${'a'.repeat(43)}`;
  try {
    const send = (suffix = '', headers: Record<string, string> = {}) =>
      fetch(`${endpoint}/plugin/mcp${suffix}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      });
    assert.equal((await send('', { 'x-agent-key-secret': 'borrowed-pro', 'x-plugin-id': 'forged' })).status, 200);
    assert.deepEqual(seen, [
      {
        path: '/api/plugin-runtime/handle',
        auth: `Bearer ${key}`,
        agent: undefined,
        pluginHeader: undefined,
      },
    ]);
    assert.equal((await send(`?token=${key}`, { authorization: '' })).status, 401);
    assert.equal((await send('', { authorization: `Bearer ${'b'.repeat(64)}` })).status, 200);
    const legacy = await fetch(`${endpoint}/dot/mcp?token=${'c'.repeat(64)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    assert.equal(legacy.status, 200);
    assert.equal(seen.length, 3);
    assert.equal(seen[1]?.auth, `Bearer ${'b'.repeat(64)}`);
    assert.equal(seen[2]?.auth, `Bearer ${'c'.repeat(64)}`);
    assert.equal((await fetch(endpoint, { method: 'GET' })).status, 405);
  } finally {
    await close(remote);
    await close(host);
  }
});

test('the public plugin proxy refuses a non-loopback Host without contacting it', async () => {
  const remote = createServer((req, res) => void handlePluginRemoteRequest(req, res, 'https://example.com'));
  const endpoint = await listen(remote);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer cpa_${'a'.repeat(43)}` },
      body: '{}',
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'plugin_host_unavailable');
  } finally {
    await close(remote);
  }
});

test('remote response is bounded while streaming, without passing a partial oversized response', async () => {
  const host = createServer((_req, res) => res.end('x'.repeat(2 * 1024 * 1024 + 1)));
  const api = await listen(host);
  const remote = createServer((req, res) => void handlePluginRemoteRequest(req, res, api));
  const endpoint = await listen(remote);
  try {
    const response = await fetch(`${endpoint}/plugin/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer cpa_${'a'.repeat(43)}`,
      },
      body: '{}',
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'plugin_host_unavailable' });
  } finally {
    await close(remote);
    await close(host);
  }
});
