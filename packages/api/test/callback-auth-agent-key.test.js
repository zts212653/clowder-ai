import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

const stubInvocationRegistry = {
  verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
};

function makeAgentKeyRegistry(validSecret = 'valid-secret') {
  return {
    verify: async (secret) => {
      if (secret === validSecret) {
        return {
          ok: true,
          record: {
            agentKeyId: 'ak_test1',
            catId: 'bengal',
            userId: 'user1',
            secretHash: 'x',
            salt: 'y',
            scope: 'user-bound',
            issuedAt: Date.now(),
            expiresAt: Date.now() + 86400000,
          },
        };
      }
      return { ok: false, reason: 'agent_key_unknown' };
    },
  };
}

async function loadPrehandler() {
  return import('../dist/routes/callback-auth-prehandler.js');
}

describe('callback-auth-prehandler: agent-key path', () => {
  it('decorates callbackPrincipal with agent_key kind on valid x-agent-key-secret', async () => {
    const { registerCallbackAuthHook } = await loadPrehandler();
    const app = Fastify();
    registerCallbackAuthHook(app, stubInvocationRegistry, {
      agentKeyRegistry: makeAgentKeyRegistry(),
    });
    app.get('/api/callbacks/test', async (request) => ({
      hasPrincipal: !!request.callbackPrincipal,
      kind: request.callbackPrincipal?.kind,
      catId: request.callbackPrincipal?.catId,
      userId: request.callbackPrincipal?.userId,
    }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/test',
      headers: { 'x-agent-key-secret': 'valid-secret' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.kind, 'agent_key');
    assert.equal(body.catId, 'bengal');
    assert.equal(body.userId, 'user1');
  });

  it('returns 401 with structured reason on invalid agent-key secret', async () => {
    const { registerCallbackAuthHook } = await loadPrehandler();
    const app = Fastify();
    registerCallbackAuthHook(app, stubInvocationRegistry, {
      agentKeyRegistry: makeAgentKeyRegistry(),
    });
    app.get('/api/callbacks/test', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/test',
      headers: { 'x-agent-key-secret': 'bad-secret' },
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error || body.reason, 'should have error info');
  });

  it('invocation token takes precedence — callbackPrincipal has kind invocation', async () => {
    const { registerCallbackAuthHook } = await loadPrehandler();
    const app = Fastify();
    const invRegistry = {
      verify: async () => ({
        ok: true,
        record: {
          invocationId: 'inv1',
          threadId: 'th1',
          userId: 'user1',
          catId: 'opus',
          callbackToken: 'tok',
          isLatest: true,
          createdAt: Date.now(),
        },
      }),
    };
    registerCallbackAuthHook(app, invRegistry, {
      agentKeyRegistry: makeAgentKeyRegistry(),
    });
    app.get('/api/callbacks/test', async (request) => ({
      hasCallbackAuth: !!request.callbackAuth,
      principalKind: request.callbackPrincipal?.kind,
    }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/test',
      headers: {
        'x-invocation-id': 'inv1',
        'x-callback-token': 'tok',
        'x-agent-key-secret': 'valid-secret',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.hasCallbackAuth, true);
    assert.equal(body.principalKind, 'invocation');
  });

  it('no credentials at all = no-op (panel request)', async () => {
    const { registerCallbackAuthHook } = await loadPrehandler();
    const app = Fastify();
    registerCallbackAuthHook(app, stubInvocationRegistry, {
      agentKeyRegistry: makeAgentKeyRegistry(),
    });
    app.get('/api/callbacks/test', async (request) => ({
      hasAuth: !!request.callbackAuth,
      hasPrincipal: !!request.callbackPrincipal,
    }));
    const res = await app.inject({ method: 'GET', url: '/api/callbacks/test' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.hasAuth, false);
    assert.equal(body.hasPrincipal, false);
  });

  it('agent-key without agentKeyRegistry configured = no-op (not 401)', async () => {
    const { registerCallbackAuthHook } = await loadPrehandler();
    const app = Fastify();
    registerCallbackAuthHook(app, stubInvocationRegistry);
    app.get('/api/callbacks/test', async (request) => ({
      hasAuth: !!request.callbackAuth,
      hasPrincipal: !!request.callbackPrincipal,
    }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/test',
      headers: { 'x-agent-key-secret': 'valid-secret' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.hasAuth, false);
    assert.equal(body.hasPrincipal, false);
  });

  it('invocation fails with agent-key also present = 401 from invocation (no fallthrough)', async () => {
    const { registerCallbackAuthHook } = await loadPrehandler();
    const app = Fastify();
    registerCallbackAuthHook(app, stubInvocationRegistry, {
      agentKeyRegistry: makeAgentKeyRegistry(),
    });
    app.get('/api/callbacks/test', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/test',
      headers: {
        'x-invocation-id': 'bad-inv',
        'x-callback-token': 'bad-tok',
        'x-agent-key-secret': 'valid-secret',
      },
    });
    assert.equal(res.statusCode, 401, 'invocation path fails first, no agent-key fallthrough');
  });
});

describe('requireCallbackPrincipal', () => {
  it('returns principal when decorated via agent-key', async () => {
    const { registerCallbackAuthHook, requireCallbackPrincipal } = await loadPrehandler();
    const app = Fastify();
    registerCallbackAuthHook(app, stubInvocationRegistry, {
      agentKeyRegistry: makeAgentKeyRegistry(),
    });
    app.get('/api/callbacks/test-require', async (request, reply) => {
      const principal = requireCallbackPrincipal(request, reply);
      if (!principal) return;
      return { kind: principal.kind, catId: principal.catId };
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/test-require',
      headers: { 'x-agent-key-secret': 'valid-secret' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.kind, 'agent_key');
    assert.equal(body.catId, 'bengal');
  });

  it('returns 401 when no principal decorated', async () => {
    const { registerCallbackAuthHook, requireCallbackPrincipal } = await loadPrehandler();
    const app = Fastify();
    registerCallbackAuthHook(app, stubInvocationRegistry);
    app.get('/api/callbacks/test-require', async (request, reply) => {
      const principal = requireCallbackPrincipal(request, reply);
      if (!principal) return;
      return { kind: principal.kind };
    });
    const res = await app.inject({ method: 'GET', url: '/api/callbacks/test-require' });
    assert.equal(res.statusCode, 401);
  });
});
