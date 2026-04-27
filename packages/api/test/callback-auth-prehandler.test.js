/**
 * Tests for unified callback auth preHandler (#476)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

describe('Callback Auth PreHandler (#476)', () => {
  /** Minimal InvocationRegistry mock — returns VerifyResult (F174 Phase A). */
  function createMockRegistry(records = new Map()) {
    return {
      async verify(invocationId, callbackToken) {
        const record = records.get(invocationId);
        if (!record) return { ok: false, reason: 'unknown_invocation' };
        if (record.callbackToken !== callbackToken) {
          return { ok: false, reason: 'invalid_token' };
        }
        return { ok: true, record };
      },
    };
  }

  async function buildApp(registry) {
    const { registerCallbackAuthHook, requireCallbackAuth } = await import(
      '../dist/routes/callback-auth-prehandler.js'
    );
    const app = Fastify({ logger: false });
    registerCallbackAuthHook(app, registry);

    // Test route that requires auth
    app.get('/test/require-auth', async (request, reply) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;
      return { threadId: record.threadId, catId: record.catId };
    });

    // Test route that optionally uses auth
    app.get('/test/optional-auth', async (request) => {
      return { hasAuth: !!request.callbackAuth };
    });

    await app.ready();
    return app;
  }

  const VALID_RECORD = {
    invocationId: 'inv-001',
    callbackToken: 'tok-001',
    threadId: 'thread-abc',
    catId: 'opus',
    userId: 'user-1',
  };

  it('decorates request.callbackAuth with verified record when headers are valid', async () => {
    const registry = createMockRegistry(new Map([['inv-001', VALID_RECORD]]));
    const app = await buildApp(registry);

    const res = await app.inject({
      method: 'GET',
      url: '/test/require-auth',
      headers: { 'x-invocation-id': 'inv-001', 'x-callback-token': 'tok-001' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.threadId, 'thread-abc');
    assert.equal(body.catId, 'opus');
    await app.close();
  });

  it('returns 401 with reason:unknown_invocation when handler requires auth but no preHandler decoration', async () => {
    // Headers absent → preHandler is no-op → callbackAuth undefined → requireCallbackAuth 401s.
    // The reason emitted by requireCallbackAuth is `unknown_invocation` (we don't actually
    // know whether creds were never supplied or were invalid — `unknown` is the safe default).
    const registry = createMockRegistry();
    const app = await buildApp(registry);

    const res = await app.inject({ method: 'GET', url: '/test/require-auth' });
    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error, 'callback_auth_failed');
    assert.equal(body.reason, 'unknown_invocation');
    assert.ok(typeof body.message === 'string');
    assert.ok(typeof body.hint === 'string');
    await app.close();
  });

  // F174 Phase A — Structured failure reasons surfaced from preHandler (KD-4)
  it('returns 401 with reason:invalid_token when token mismatches', async () => {
    const registry = createMockRegistry(new Map([['inv-001', VALID_RECORD]]));
    const app = await buildApp(registry);

    const res = await app.inject({
      method: 'GET',
      url: '/test/require-auth',
      headers: { 'x-invocation-id': 'inv-001', 'x-callback-token': 'wrong-token' },
    });

    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error, 'callback_auth_failed');
    assert.equal(body.reason, 'invalid_token');
    await app.close();
  });

  it('returns 401 with reason:unknown_invocation when invocationId not in registry', async () => {
    const registry = createMockRegistry(); // empty
    const app = await buildApp(registry);

    const res = await app.inject({
      method: 'GET',
      url: '/test/require-auth',
      headers: { 'x-invocation-id': 'never-seen', 'x-callback-token': 'any' },
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.json().reason, 'unknown_invocation');
    await app.close();
  });

  it('returns 401 with reason:missing_creds when only one header present', async () => {
    const registry = createMockRegistry(new Map([['inv-001', VALID_RECORD]]));
    const app = await buildApp(registry);

    const res = await app.inject({
      method: 'GET',
      url: '/test/require-auth',
      headers: { 'x-invocation-id': 'inv-001' }, // missing token
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.json().reason, 'missing_creds');
    await app.close();
  });

  it('returns 401 from preHandler when credentials are invalid (fail-closed, #474)', async () => {
    const registry = createMockRegistry(new Map([['inv-001', VALID_RECORD]]));
    const app = await buildApp(registry);

    const res = await app.inject({
      method: 'GET',
      url: '/test/optional-auth',
      headers: { 'x-invocation-id': 'inv-001', 'x-callback-token': 'wrong-token' },
    });

    assert.equal(res.statusCode, 401, 'bad creds must be rejected at preHandler, not silently ignored');
    await app.close();
  });

  it('returns 401 from preHandler when only one header is present (malformed)', async () => {
    const registry = createMockRegistry(new Map([['inv-001', VALID_RECORD]]));
    const app = await buildApp(registry);

    const res = await app.inject({
      method: 'GET',
      url: '/test/optional-auth',
      headers: { 'x-invocation-id': 'inv-001' },
    });

    assert.equal(res.statusCode, 401, 'partial headers must be rejected, not treated as panel request');
    await app.close();
  });

  it('leaves callbackAuth undefined when headers absent (panel/optional path)', async () => {
    const registry = createMockRegistry();
    const app = await buildApp(registry);

    const res = await app.inject({ method: 'GET', url: '/test/optional-auth' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().hasAuth, false);
    await app.close();
  });

  // ---- Legacy body/query fallback (#476 compat window) ----

  it('accepts legacy credentials from POST body when headers absent', async () => {
    const registry = createMockRegistry(new Map([['inv-001', VALID_RECORD]]));
    const { registerCallbackAuthHook, requireCallbackAuth } = await import(
      '../dist/routes/callback-auth-prehandler.js'
    );
    const app = Fastify({ logger: false });
    registerCallbackAuthHook(app, registry);

    app.post('/test/require-auth', async (request, reply) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;
      return { threadId: record.threadId, catId: record.catId };
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/test/require-auth',
      payload: { invocationId: 'inv-001', callbackToken: 'tok-001', data: 'test' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.threadId, 'thread-abc');
    assert.equal(body.catId, 'opus');
    await app.close();
  });

  it('accepts legacy credentials from GET query when headers absent', async () => {
    const registry = createMockRegistry(new Map([['inv-001', VALID_RECORD]]));
    const app = await buildApp(registry);

    const res = await app.inject({
      method: 'GET',
      url: '/test/require-auth?invocationId=inv-001&callbackToken=tok-001',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.threadId, 'thread-abc');
    await app.close();
  });

  it('prefers headers over legacy body credentials', async () => {
    const headerRecord = {
      invocationId: 'inv-header',
      callbackToken: 'tok-header',
      threadId: 'thread-from-header',
      catId: 'opus',
      userId: 'user-1',
    };
    const bodyRecord = {
      invocationId: 'inv-body',
      callbackToken: 'tok-body',
      threadId: 'thread-from-body',
      catId: 'codex',
      userId: 'user-2',
    };
    const registry = createMockRegistry(
      new Map([
        ['inv-header', headerRecord],
        ['inv-body', bodyRecord],
      ]),
    );
    const { registerCallbackAuthHook, requireCallbackAuth } = await import(
      '../dist/routes/callback-auth-prehandler.js'
    );
    const app = Fastify({ logger: false });
    registerCallbackAuthHook(app, registry);

    app.post('/test/require-auth', async (request, reply) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;
      return { threadId: record.threadId, catId: record.catId };
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/test/require-auth',
      headers: { 'x-invocation-id': 'inv-header', 'x-callback-token': 'tok-header' },
      payload: { invocationId: 'inv-body', callbackToken: 'tok-body' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.threadId, 'thread-from-header', 'headers must take precedence over body');
    assert.equal(body.catId, 'opus');
    await app.close();
  });

  it('returns 401 when legacy body credentials are invalid', async () => {
    const registry = createMockRegistry(new Map([['inv-001', VALID_RECORD]]));
    const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');
    const app = Fastify({ logger: false });
    registerCallbackAuthHook(app, registry);

    app.post('/test/optional-auth', async (request) => {
      return { hasAuth: !!request.callbackAuth };
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/test/optional-auth',
      payload: { invocationId: 'inv-001', callbackToken: 'wrong-token' },
    });

    assert.equal(res.statusCode, 401, 'invalid legacy creds must still be rejected (fail-closed)');
    await app.close();
  });

  it('returns 401 when only one legacy body credential is present (partial → fail-closed)', async () => {
    const registry = createMockRegistry(new Map([['inv-001', VALID_RECORD]]));
    const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');
    const app = Fastify({ logger: false });
    registerCallbackAuthHook(app, registry);

    app.post('/test/optional-auth', async (request) => {
      return { hasAuth: !!request.callbackAuth };
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/test/optional-auth',
      payload: { invocationId: 'inv-001' },
    });

    assert.equal(res.statusCode, 401, 'partial legacy creds must be rejected, not treated as panel request');
    await app.close();
  });
});
