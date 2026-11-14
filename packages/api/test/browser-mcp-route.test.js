import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import Fastify from 'fastify';
import { registerBrowserMcpRoutes } from '../dist/routes/browser-mcp.js';

const RECORD = {
  catId: 'opus55',
  userId: 'default-user',
  threadId: 'thread_alpha',
  sharedMcpContext: { v: 1, deploymentId: 'deploy-1', workspaceRoot: '/ws/cat-cafe', capabilityRoot: '/ws/cat-cafe' },
};

async function childStub() {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1', 'set-cookie': 'x=1' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, server, port: server.address().port };
}

async function api({ record = RECORD, enabled = true, endpoint }) {
  const app = Fastify();
  let endpointCalls = 0;
  registerBrowserMcpRoutes(app, {
    registry: {
      isStartupRecoveryComplete: () => true,
      verifyLatest: async (id, token) =>
        id === 'inv-1' && token === 'tok-1' ? { ok: true, record } : { ok: false, reason: 'x' },
    },
    deploymentId: 'deploy-1',
    browser: {
      endpoint: async () => {
        endpointCalls++;
        return endpoint();
      },
    },
    hasSharedBrowser: () => enabled,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url: `http://127.0.0.1:${app.server.address().port}/api/browser-mcp/mcp`, calls: () => endpointCalls };
}

const identity = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'x-invocation-id': 'inv-1',
  'x-callback-token': 'tok-1',
  'x-mcp-connection-id': 'conn-1',
};

test('requests without a current invocation or without the browser capability never reach the child', async () => {
  const child = await childStub();
  const off = await api({ enabled: false, endpoint: () => ({ port: child.port, key: 'k' }) });
  const other = await api({
    record: { ...RECORD, sharedMcpContext: { ...RECORD.sharedMcpContext, deploymentId: 'old' } },
    endpoint: () => ({ port: child.port, key: 'k' }),
  });
  try {
    assert.equal((await fetch(off.url, { method: 'POST', body: '{}' })).status, 401);
    const wrongToken = await fetch(off.url, {
      method: 'POST',
      headers: { ...identity, 'x-callback-token': 'nope' },
      body: '{}',
    });
    assert.equal(wrongToken.status, 401);
    const disabled = await fetch(off.url, { method: 'POST', headers: identity, body: '{}' });
    assert.equal(disabled.status, 403);
    assert.equal((await disabled.json()).error, 'shared_browser_not_enabled');
    assert.equal((await fetch(other.url, { method: 'POST', headers: identity, body: '{}' })).status, 403);
    assert.equal(child.seen.length, 0);
    assert.equal(off.calls() + other.calls(), 0, 'the browser process is not even started');
  } finally {
    await off.app.close();
    await other.app.close();
    child.server.close();
  }
});

test('the child gets allowlisted headers plus verified identity, never the callback token', async () => {
  const child = await childStub();
  const { app, url } = await api({ endpoint: () => ({ port: child.port, key: 'k'.repeat(64) }) });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...identity, 'mcp-session-id': 'sess-1', cookie: 'hub=secret', 'x-cat-cafe-browser-thread': 'forged' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('mcp-session-id'), null, 'stateless edge: no session id either way');
    assert.equal(res.headers.get('set-cookie'), null, 'response headers are allowlisted too');
    const [seen] = child.seen;
    assert.equal(seen.headers['x-callback-token'], undefined);
    assert.equal(seen.headers['x-invocation-id'], undefined);
    assert.equal(seen.headers.cookie, undefined);
    assert.equal(seen.headers['x-cat-cafe-browser-key'], 'k'.repeat(64));
    assert.equal(seen.headers['x-cat-cafe-browser-thread'], 'thread_alpha', 'identity comes from the registry');
    assert.equal(seen.headers['x-cat-cafe-browser-workspace'], '/ws/cat-cafe');
    assert.equal(seen.headers['x-cat-cafe-browser-binding'], createHash('sha256').update('inv-1:conn-1').digest('hex'));
    assert.equal(seen.headers['mcp-session-id'], undefined);
    assert.equal(JSON.parse(seen.body).method, 'tools/list');
  } finally {
    await app.close();
    child.server.close();
  }
});

test('a failed child returns one error and the browser action is not replayed', async () => {
  const child = await childStub();
  const port = child.port;
  await new Promise((resolve) => child.server.close(resolve)); // nothing listens on this port now
  const { app, url, calls } = await api({ endpoint: () => ({ port, key: 'k' }) });
  try {
    const res = await fetch(url, { method: 'POST', headers: identity, body: '{}' });
    assert.equal(res.status, 502);
    assert.equal(calls(), 1);
    const unavailable = await api({
      endpoint: () => {
        throw new Error('start failed');
      },
    });
    const res2 = await fetch(unavailable.url, { method: 'POST', headers: identity, body: '{}' });
    assert.equal(res2.status, 503);
    await unavailable.app.close();
  } finally {
    await app.close();
  }
});

test('GET and DELETE are not part of the stateless edge', async () => {
  const { app, url } = await api({ endpoint: () => ({ port: 1, key: 'k' }) });
  try {
    assert.equal((await fetch(url, { headers: identity })).status, 405);
    assert.equal((await fetch(url, { method: 'DELETE', headers: identity })).status, 405);
  } finally {
    await app.close();
  }
});

test('Origin, forwarded and non-loopback requests never reach verification or the child (R1 P1-3)', async () => {
  const child = await childStub();
  const { app, url, calls } = await api({ endpoint: () => ({ port: child.port, key: 'k' }) });
  try {
    const withOrigin = await fetch(url, {
      method: 'POST',
      headers: { ...identity, origin: 'http://evil.test' },
      body: '{}',
    });
    assert.equal(withOrigin.status, 403);
    const forwarded = await fetch(url, {
      method: 'POST',
      headers: { ...identity, 'x-forwarded-for': '1.2.3.4' },
      body: '{}',
    });
    assert.equal(forwarded.status, 403);
    const remote = await app.inject({
      method: 'POST',
      url: '/api/browser-mcp/mcp',
      headers: identity,
      payload: '{}',
      remoteAddress: '10.0.0.2',
    });
    assert.equal(remote.statusCode, 403);
    assert.equal(remote.json().error, 'shared_loopback_only');
    const queryCredential = await fetch(`${url}?token=leaked`, { method: 'POST', headers: identity, body: '{}' });
    assert.equal(queryCredential.status, 403, 'valid headers do not excuse a credential in the URL (R2 P2)');
    assert.equal((await queryCredential.json()).error, 'query_credentials_rejected');
    assert.equal(calls(), 0);
    assert.equal(child.seen.length, 0);
  } finally {
    await app.close();
    child.server.close();
  }
});
