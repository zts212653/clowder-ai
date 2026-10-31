import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { handleDotRemoteRequest } from '../src/dot-remote-proxy.js';

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

test('remote dot forwards only its own credential to the fixed local Host; Pro and caller headers never cross', async () => {
  const seen: Array<{ path: string; auth: string | undefined; agent: string | string[] | undefined }> = [];
  const host = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain the bounded request */
    }
    seen.push({ path: req.url!, auth: req.headers.authorization, agent: req.headers['x-agent-key-secret'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
  });
  const api = await listen(host);
  const remote = createServer((req, res) => void handleDotRemoteRequest(req, res, api));
  const endpoint = await listen(remote);
  const key = 'a'.repeat(64);
  try {
    const send = (suffix: string, headers: Record<string, string> = {}) =>
      fetch(`${endpoint}/dot/mcp${suffix}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      });
    assert.equal(
      (await send(`?token=${key}`, { 'x-agent-key-secret': 'borrowed-pro', 'x-cat-id': 'gpt-pro' })).status,
      200,
    );
    assert.deepEqual(seen, [{ path: '/api/plugins/chatgpt-dot/mcp', auth: `Bearer ${key}`, agent: undefined }]);
    assert.equal((await send('')).status, 401);
    assert.equal((await send(`?token=${key}&token=${key}`)).status, 401);
    assert.equal((await send(`?token=${key}`, { authorization: `Bearer ${'b'.repeat(64)}` })).status, 401);
    assert.equal(seen.length, 1);
    assert.equal((await fetch(endpoint, { method: 'GET' })).status, 405);
  } finally {
    await close(remote);
    await close(host);
  }
});

test('remote dot refuses a non-loopback Host without contacting it', async () => {
  const remote = createServer((req, res) => void handleDotRemoteRequest(req, res, 'https://example.com'));
  const endpoint = await listen(remote);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'dot_host_unavailable');
  } finally {
    await close(remote);
  }
});

test('remote response is bounded while streaming, without passing a partial oversized response', async () => {
  const host = createServer((_req, res) => res.end('x'.repeat(2 * 1024 * 1024 + 1)));
  const api = await listen(host);
  const remote = createServer((req, res) => void handleDotRemoteRequest(req, res, api));
  const endpoint = await listen(remote);
  try {
    const response = await fetch(`${endpoint}/dot/mcp?token=${'a'.repeat(64)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'dot_host_unavailable' });
  } finally {
    await close(remote);
    await close(host);
  }
});
