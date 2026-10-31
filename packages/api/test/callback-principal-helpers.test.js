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

  test('resolvePrincipalThread() allows scoped soft-deleted thread for read/write route policy to decide', async () => {
    const { resolvePrincipalThread } = await import('../dist/routes/callback-scope-helpers.js');
    const principal = { kind: 'agent_key', agentKeyId: 'ak_1', userId: 'u1', catId: 'codex', scope: 'user-bound' };
    const result = await resolvePrincipalThread(principal, 'thread-deleted', {
      threadStore: {
        async get() {
          return { id: 'thread-deleted', createdBy: 'u1', deletedAt: Date.now() };
        },
      },
    });
    assert.deepEqual(result, { ok: true, threadId: 'thread-deleted' });
  });

  test('resolvePrincipalThread() does not reveal soft-deleted threads outside agent_key scope', async () => {
    const { resolvePrincipalThread } = await import('../dist/routes/callback-scope-helpers.js');
    const principal = { kind: 'agent_key', agentKeyId: 'ak_1', userId: 'u1', catId: 'codex', scope: 'user-bound' };
    const result = await resolvePrincipalThread(principal, 'thread-deleted', {
      threadStore: {
        async get() {
          return { id: 'thread-deleted', createdBy: 'u2', deletedAt: Date.now() };
        },
      },
      accessDeniedError: 'Thread access denied',
    });
    assert.deepEqual(result, {
      ok: false,
      statusCode: 403,
      error: 'Thread access denied',
    });
  });

  test('getDeletedCallbackThreadGuard() blocks known soft-deleted threads', async () => {
    const { getDeletedCallbackThreadGuard } = await import('../dist/routes/callback-scope-helpers.js');
    const result = await getDeletedCallbackThreadGuard(
      {
        async get() {
          return { deletedAt: Date.now() };
        },
      },
      'thread-deleted',
    );

    assert.deepEqual(result, {
      statusCode: 410,
      body: {
        error: 'Thread is deleted',
        code: 'THREAD_DELETED',
      },
    });
  });

  test('getDeletedCallbackThreadGuard() allows active threads', async () => {
    const { getDeletedCallbackThreadGuard } = await import('../dist/routes/callback-scope-helpers.js');
    const result = await getDeletedCallbackThreadGuard(
      {
        async get() {
          return { deletedAt: null };
        },
      },
      'thread-active',
    );

    assert.equal(result, null);
  });

  test('getDeletedCallbackThreadGuard() fails open when threadStore.get throws', async () => {
    const { getDeletedCallbackThreadGuard } = await import('../dist/routes/callback-scope-helpers.js');
    const result = await getDeletedCallbackThreadGuard(
      {
        async get() {
          throw new Error('redis down');
        },
      },
      'thread-unknown',
    );

    assert.equal(result, null);
  });

  test('resolvePrincipalThread() allows agent_key access to indexed system threads', async () => {
    const { resolvePrincipalThread } = await import('../dist/routes/callback-scope-helpers.js');
    const principal = { kind: 'agent_key', agentKeyId: 'ak_1', userId: 'u1', catId: 'codex', scope: 'user-bound' };
    const result = await resolvePrincipalThread(principal, 'thread_eval_memory', {
      threadStore: {
        async get() {
          return { id: 'thread_eval_memory', createdBy: 'system' };
        },
        async list() {
          return [
            { id: 'thread-source', createdBy: 'u1' },
            { id: 'thread_eval_memory', createdBy: 'system' },
          ];
        },
      },
    });
    assert.deepEqual(result, { ok: true, threadId: 'thread_eval_memory' });
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
