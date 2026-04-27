import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('CallbackPrincipal helpers', () => {
  test('derivePrincipal() from InvocationRecord returns kind:invocation', async () => {
    const { derivePrincipal } = await import('../dist/routes/callback-scope-helpers.js');
    const record = {
      invocationId: 'inv-1',
      callbackToken: 'tok',
      userId: 'user-1',
      catId: 'opus',
      threadId: 'thread-1',
      clientMessageIds: new Set(),
      createdAt: Date.now(),
      expiresAt: Date.now() + 10000,
    };
    const p = derivePrincipal(record);
    assert.equal(p.kind, 'invocation');
    assert.equal(p.threadId, 'thread-1');
    assert.equal(p.invocationId, 'inv-1');
  });

  test('derivePrincipal() from AgentKeyRecord returns kind:agent_key', async () => {
    const { derivePrincipal } = await import('../dist/routes/callback-scope-helpers.js');
    const record = {
      agentKeyId: 'ak_123',
      catId: 'bengal',
      userId: 'user-1',
      secretHash: 'xxx',
      salt: 'yyy',
      scope: 'user-bound',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 10000,
    };
    const p = derivePrincipal(record);
    assert.equal(p.kind, 'agent_key');
    assert.equal(p.agentKeyId, 'ak_123');
    assert.equal(p.scope, 'user-bound');
    assert.equal('threadId' in p, false);
  });

  test('resolvePrincipalThread() requires explicit threadId for agent_key', async () => {
    const { resolvePrincipalThread } = await import('../dist/routes/callback-scope-helpers.js');
    const principal = { kind: 'agent_key', agentKeyId: 'ak_1', userId: 'u1', catId: 'bengal', scope: 'user-bound' };
    const noThread = await resolvePrincipalThread(principal, undefined, {});
    assert.equal(noThread.ok, false);
    assert.equal(noThread.statusCode, 400);
  });

  test('resolvePrincipalThread() allows invocation to use bound thread', async () => {
    const { resolvePrincipalThread } = await import('../dist/routes/callback-scope-helpers.js');
    const principal = { kind: 'invocation', invocationId: 'i1', threadId: 't1', userId: 'u1', catId: 'opus' };
    const result = await resolvePrincipalThread(principal, undefined, {});
    assert.equal(result.ok, true);
    assert.equal(result.threadId, 't1');
  });

  test('deriveCallbackActor() still works unchanged', async () => {
    const { deriveCallbackActor } = await import('../dist/routes/callback-scope-helpers.js');
    const record = {
      invocationId: 'inv-1',
      callbackToken: 'tok',
      userId: 'user-1',
      catId: 'opus',
      threadId: 'thread-1',
      clientMessageIds: new Set(),
      createdAt: Date.now(),
      expiresAt: Date.now() + 10000,
    };
    const actor = deriveCallbackActor(record);
    assert.equal(actor.invocationId, 'inv-1');
    assert.equal(actor.threadId, 'thread-1');
  });
});
