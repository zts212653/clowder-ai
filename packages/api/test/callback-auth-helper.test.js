import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('callback auth helper', () => {
  test('returns panel mode when callback credentials are absent', async () => {
    const { resolveOptionalCallbackAuth } = await import('../dist/routes/callback-auth-helper.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const registry = new InvocationRegistry();

    const result = resolveOptionalCallbackAuth({ body: {}, query: {}, headers: {} }, registry, { requireLatest: true });

    assert.equal(result.ok, true);
    assert.equal(result.record, null);
    assert.equal(result.source, null);
  });

  test('returns INVALID_CALLBACK_CREDENTIALS when callback pair is incomplete', async () => {
    const { resolveOptionalCallbackAuth } = await import('../dist/routes/callback-auth-helper.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const registry = new InvocationRegistry();

    const result = resolveOptionalCallbackAuth(
      {
        body: { invocationId: 'only-invocation' },
        query: {},
        headers: {},
      },
      registry,
      { requireLatest: true },
    );

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 401);
    assert.equal(result.body.error, 'INVALID_CALLBACK_CREDENTIALS');
  });

  test('returns STALE_INVOCATION when invocation is no longer latest', async () => {
    const { resolveOptionalCallbackAuth } = await import('../dist/routes/callback-auth-helper.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const registry = new InvocationRegistry();
    const stale = registry.create('user-1', 'codex', 'thread-1');
    registry.create('user-1', 'codex', 'thread-1'); // supersede stale

    const result = resolveOptionalCallbackAuth(
      {
        body: {
          invocationId: stale.invocationId,
          callbackToken: stale.callbackToken,
        },
        query: {},
        headers: {},
      },
      registry,
      { requireLatest: true },
    );

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.error, 'STALE_INVOCATION');
  });
});
