/**
 * Member MCP gateway route — /api/member-mcp/mcp auth & wiring contract.
 *
 * The route hosts the member gateway (packages/mcp-server/dist/member-gateway)
 * inside the API process and authenticates every request against the REAL
 * F298 InvocationRegistry: only active invocations may use their credentials;
 * terminal invocations fail closed (this is the timely-revocation guarantee
 * that lets every ACP turn carry fresh credentials).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { registerMemberMcpRoutes } = await import('../dist/routes/member-mcp.js');

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'route-test', version: '0.0.1' } },
};

async function createApp({ families = ['collab'] } = {}) {
  const registry = new InvocationRegistry();
  const app = Fastify();
  registerMemberMcpRoutes(app, {
    registry,
    resolveMemberToolFamilies: async () => families,
    apiBaseUrl: 'http://127.0.0.1:59999',
    log: { warn() {} },
  });
  await app.ready();
  return { app, registry };
}

function post(app, { headers, path = '/api/member-mcp/mcp', body = INIT_BODY } = {}) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    payload: JSON.stringify(body),
  });
}

describe('member-mcp route', () => {
  it('answers an active invocation with the MCP handshake', async () => {
    const { app, registry } = await createApp();
    try {
      const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');
      const res = await post(app, {
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      });
      assert.equal(res.statusCode, 200);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed?.result?.serverInfo?.name, 'cat-cafe-member');
    } finally {
      await app.close();
    }
  });

  it('enforces the exact durable invocation policy for advertisement and calls', async () => {
    const { app, registry } = await createApp({ families: ['collab'] });
    const fetchCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith('http://127.0.0.1:59999')) return originalFetch(url, init);
      fetchCalls.push({ url: String(url), headers: init?.headers ?? {} });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const readOnly = await registry.create('user-1', 'opus', 'thread-1', undefined, undefined, {
        mode: 'read_only',
        replayDeniedToolNames: [],
      });
      const readOnlyHeaders = { 'x-invocation-id': readOnly.invocationId, 'x-callback-token': readOnly.callbackToken };
      const list = await post(app, {
        headers: readOnlyHeaders,
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      });
      assert.equal(list.statusCode, 200);
      const names = (JSON.parse(list.body)?.result?.tools ?? []).map((tool) => tool.name);
      assert.deepEqual(names, [], 'read_only denies every tool, not just writes');

      const call = await post(app, {
        headers: readOnlyHeaders,
        body: {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'cat_cafe_get_rich_block_rules', arguments: {} },
        },
      });
      assert.equal(call.statusCode, 200);
      const callPayload = JSON.parse(call.body);
      assert.ok(
        callPayload?.error || callPayload?.result?.isError === true,
        `a denied read tool must not execute, got ${call.body}`,
      );
      assert.equal(fetchCalls.length, 0, 'a denied tool call must never reach the callback API');

      const allowlisted = await registry.create('user-1', 'sonnet', 'thread-2', undefined, undefined, {
        mode: 'callback_allowlist',
        allowedCallbackRoutes: ['POST /api/callbacks/post-message'],
      });
      const allowlistList = await post(app, {
        headers: { 'x-invocation-id': allowlisted.invocationId, 'x-callback-token': allowlisted.callbackToken },
        body: { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
      });
      const allowlistNames = (JSON.parse(allowlistList.body)?.result?.tools ?? []).map((tool) => tool.name);
      assert.deepEqual(allowlistNames, [], 'callback_allowlist cannot be represented as MCP tools and fails closed');
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });

  it('keeps the family surface for an invocation without a durable policy', async () => {
    const { app, registry } = await createApp({ families: ['collab'] });
    try {
      const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');
      const res = await post(app, {
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        body: { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} },
      });
      assert.equal(res.statusCode, 200);
      const names = (JSON.parse(res.body)?.result?.tools ?? []).map((tool) => tool.name);
      assert.ok(names.includes('cat_cafe_post_message'));
      assert.ok(names.includes('cat_cafe_get_rich_block_rules'));
    } finally {
      await app.close();
    }
  });

  it('rejects requests without credentials', async () => {
    const { app } = await createApp();
    try {
      const res = await post(app, {});
      assert.equal(res.statusCode, 401);
      assert.ok(!res.body.includes('callbackToken'));
    } finally {
      await app.close();
    }
  });

  it('rejects a wrong callback token', async () => {
    const { app, registry } = await createApp();
    try {
      const { invocationId } = await registry.create('user-1', 'opus', 'thread-1');
      const res = await post(app, {
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': 'not-the-token' },
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  it('rejects credentials of a terminal invocation (per-turn revocation)', async () => {
    const { app, registry } = await createApp();
    try {
      const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');
      await registry.commitTerminal({
        invocationId,
        disposition: 'completed',
        endedAt: Date.now(),
        endReason: 'test',
        terminalRef: `turn_execution:${invocationId}`,
      });
      const res = await post(app, {
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      });
      assert.equal(res.statusCode, 401);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed?.error, 'completed');
    } finally {
      await app.close();
    }
  });

  it('rejects GET with 405 and forwarded headers with 403', async () => {
    const { app, registry } = await createApp();
    try {
      const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');
      const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
      const getRes = await app.inject({ method: 'GET', url: '/api/member-mcp/mcp', headers });
      assert.equal(getRes.statusCode, 405);
      const fwdRes = await post(app, { headers: { ...headers, 'x-forwarded-for': '10.0.0.1' } });
      assert.equal(fwdRes.statusCode, 403);
    } finally {
      await app.close();
    }
  });
});
