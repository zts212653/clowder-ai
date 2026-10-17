/**
 * Member MCP gateway — HTTP MCP endpoint contract for ACP (iCode) members.
 *
 * The gateway reuses the canonical tool registry (server-toolsets) and binds
 * per-invocation credentials through AsyncLocalStorage (withInvocationCredentials)
 * so tool handlers callback to the API with x-invocation-id / x-callback-token
 * headers. These tests exercise the real Streamable-HTTP transport end to end:
 *
 *  - credentials come ONLY from headers; missing/invalid → 401 without echoing secrets
 *  - query-string credentials and forwarded headers are rejected
 *  - tool surface follows the resolved member families
 *  - tool handlers run inside the ALS credential scope and use the scoped API base URL
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const { createMemberGatewayHandler } = await import('../dist/member-gateway.js');

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'gateway-test', version: '0.0.1' } },
};

const VALID_HEADERS = { 'x-invocation-id': 'inv-1', 'x-callback-token': 'tok-1' };

function makeDeps(overrides = {}) {
  return {
    verify: async ({ invocationId, callbackToken }) =>
      invocationId === 'inv-1' && callbackToken === 'tok-1'
        ? {
            ok: true,
            context: {
              invocationId: 'inv-1',
              callbackToken: 'tok-1',
              catId: 'opus',
              threadId: 'th-1',
              userId: 'u-1',
              apiBaseUrl: 'http://127.0.0.1:59999',
            },
          }
        : { ok: false, reason: 'invalid_token' },
    resolveFamilies: async () => ['collab'],
    ...overrides,
  };
}

describe('member gateway', () => {
  let server;
  let port;
  let deps;

  before(async () => {
    deps = makeDeps();
    const handler = createMemberGatewayHandler(deps);
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        let body;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          body = undefined;
        }
        handler(req, res, body).catch(() => {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"error":"internal"}');
        });
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    // Credential files must never be read from the dev worktree in tests.
    process.env.CAT_CAFE_MCP_CREDS_DIR = mkdtempSync(join(tmpdir(), 'member-gateway-creds-'));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function rpc(body, headers = {}, { path = '/mcp' } = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* SSE or empty body */
    }
    return { status: res.status, json, text };
  }

  it('rejects requests without credentials (401, no secret echo)', async () => {
    const res = await rpc(INIT_BODY);
    assert.equal(res.status, 401);
    assert.ok(!res.text.includes('tok-'), 'response must not echo credential material');
  });

  it('rejects invalid credentials with the typed reason', async () => {
    const res = await rpc(INIT_BODY, { 'x-invocation-id': 'inv-1', 'x-callback-token': 'tok-wrong' });
    assert.equal(res.status, 401);
    assert.equal(res.json?.error, 'invalid_token');
    assert.ok(!res.text.includes('tok-wrong'));
  });

  it('rejects credentials in the query string even with valid headers (403)', async () => {
    const res = await rpc(INIT_BODY, VALID_HEADERS, { path: '/mcp?token=tok-1' });
    assert.equal(res.status, 403);
  });

  it('rejects forwarded headers (403)', async () => {
    const res = await rpc(INIT_BODY, { ...VALID_HEADERS, 'x-forwarded-for': '10.0.0.1' });
    assert.equal(res.status, 403);
  });

  it('initializes and lists the collab surface for a valid invocation', async () => {
    const init = await rpc(INIT_BODY, VALID_HEADERS);
    assert.equal(init.status, 200);
    assert.equal(init.json?.result?.serverInfo?.name, 'cat-cafe-member');

    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, VALID_HEADERS);
    assert.equal(list.status, 200);
    const names = (list.json?.result?.tools ?? []).map((tool) => tool.name);
    assert.ok(names.includes('cat_cafe_post_message'), 'collab surface must include cat_cafe_post_message');
    assert.ok(names.includes('cat_cafe_multi_mention'), 'collab surface must include cat_cafe_multi_mention');
  });

  it('serves an empty surface when the member has no tool families', async () => {
    const emptyDeps = makeDeps({ resolveFamilies: async () => [] });
    const emptyServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const handler = createMemberGatewayHandler(emptyDeps);
        handler(req, res, raw ? JSON.parse(raw) : undefined).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
    });
    await new Promise((resolve) => emptyServer.listen(0, '127.0.0.1', resolve));
    try {
      const emptyPort = emptyServer.address().port;
      const res = await fetch(`http://127.0.0.1:${emptyPort}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...VALID_HEADERS },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      });
      const json = await res.json();
      assert.equal(res.status, 200);
      // A member with no tool families gets no tools capability at all: the SDK
      // is spec-correct to answer tools/list with method-not-found. The contract
      // we pin here: the gateway never fabricates a tool surface.
      const tools = json?.result?.tools ?? [];
      assert.ok(
        json?.error?.code === -32601 || tools.length === 0,
        `a member with no families must never be served tools (got ${JSON.stringify(json)})`,
      );
    } finally {
      await new Promise((resolve) => emptyServer.close(resolve));
    }
  });

  it('runs tool handlers inside the ALS credential scope with the scoped API base URL', async () => {
    const fetchCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (!target.startsWith('http://127.0.0.1:59999')) {
        // The test's own JSON-RPC traffic must keep using the real fetch.
        return originalFetch(url, init);
      }
      fetchCalls.push({ url: target, headers: init?.headers ?? {} });
      return new Response(JSON.stringify({ ok: true, cats: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const res = await rpc(
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'cat_cafe_get_thread_cats', arguments: {} } },
        VALID_HEADERS,
      );
      assert.equal(res.status, 200);
      assert.equal(fetchCalls.length, 1, 'tool handler must perform exactly one API callback');
      const call = fetchCalls[0];
      assert.ok(
        call.url.startsWith('http://127.0.0.1:59999'),
        `callback must use the scoped apiBaseUrl, got ${call.url}`,
      );
      const headers = call.headers;
      assert.equal(headers['x-invocation-id'], 'inv-1');
      assert.equal(headers['x-callback-token'], 'tok-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resolves env-dependent tool identity from the invocation scope, never the host env', async () => {
    const fetchCalls = [];
    const originalFetch = globalThis.fetch;
    const previous = {
      CAT_CAFE_API_URL: process.env.CAT_CAFE_API_URL,
      CAT_CAFE_CAT_ID: process.env.CAT_CAFE_CAT_ID,
      CAT_CAFE_USER_ID: process.env.CAT_CAFE_USER_ID,
    };
    // Decoys: the API host process env must never win over the verified scope.
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:59123';
    process.env.CAT_CAFE_CAT_ID = 'env-decoy';
    process.env.CAT_CAFE_USER_ID = 'env-decoy-user';
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (!target.startsWith('http://127.0.0.1:59999')) {
        // The test's own JSON-RPC traffic must keep using the real fetch.
        return originalFetch(url, init);
      }
      fetchCalls.push({ url: target, headers: init?.headers ?? {} });
      return new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const res = await rpc(
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'cat_cafe_submit_game_action',
            arguments: {
              gameId: '6f1b2c3d-0000-4000-8000-000000000000',
              round: 1,
              phase: 'day_vote',
              seat: 1,
              action: 'vote',
              target: 2,
              nonce: 'member-gateway-scope-nonce-1',
            },
          },
        },
        VALID_HEADERS,
      );
      assert.equal(res.status, 200);
      assert.equal(fetchCalls.length, 1, 'game action tool must perform exactly one API callback');
      const call = fetchCalls[0];
      assert.ok(
        call.url.startsWith('http://127.0.0.1:59999'),
        `callback must use the scoped apiBaseUrl, got ${call.url}`,
      );
      assert.equal(call.headers['x-cat-id'], 'opus', 'member identity must come from the verified scope');
      assert.equal(call.headers['x-cat-cafe-user'], 'u-1', 'user identity must come from the verified scope');
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('answers non-POST methods with 405', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'GET', headers: VALID_HEADERS });
    assert.equal(res.status, 405);
  });

  it('keeps rejecting credentials that are no longer active (revocation)', async () => {
    const revokedDeps = makeDeps({
      verify: async () => ({ ok: false, reason: 'completed' }),
    });
    const revokedServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const handler = createMemberGatewayHandler(revokedDeps);
        handler(req, res, raw ? JSON.parse(raw) : undefined).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
    });
    await new Promise((resolve) => revokedServer.listen(0, '127.0.0.1', resolve));
    try {
      const revokedPort = revokedServer.address().port;
      const res = await fetch(`http://127.0.0.1:${revokedPort}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...VALID_HEADERS },
        body: JSON.stringify(INIT_BODY),
      });
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json?.error, 'completed');
    } finally {
      await new Promise((resolve) => revokedServer.close(resolve));
    }
  });
});
