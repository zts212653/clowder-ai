import assert from 'node:assert/strict';
import test from 'node:test';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { authRecordFromRedisHash } from '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationRecord.js';
import { clearAuthTestNamespace, createAuthTestNamespace } from './helpers/redis-auth-namespace.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const context = {
  v: 1,
  deploymentId: 'fixture',
  workspaceRoot: '/fixture/work',
  dataDir: '/fixture/data',
  allowedWorkspaceDirs: ['/fixture/work'],
  capabilityRoot: '/fixture/config',
  families: ['memory'],
};

test('original invocation owns the immutable shared MCP projection and revocation', async () => {
  const registry = new InvocationRegistry();
  const credentials = await Reflect.apply(registry.create, registry, [
    'fixture-user',
    'codex',
    'fixture-thread',
    undefined,
    undefined,
    undefined,
    undefined,
    'strict',
    undefined,
    context,
  ]);
  const result = await registry.verify(credentials.invocationId, credentials.callbackToken);
  assert.ok(result.ok);
  assert.deepEqual(result.record.sharedMcpContext, context);
  context.allowedWorkspaceDirs.push('/fixture/forged');
  const read = await registry.getRecord(credentials.invocationId);
  assert.ok(!JSON.stringify(read.sharedMcpContext).includes('forged'));
  context.allowedWorkspaceDirs.pop();
  await registry.commitTerminal({
    invocationId: credentials.invocationId,
    disposition: 'revoked',
    endedAt: Date.now(),
    endReason: 'fixture-revoke',
  });
  assert.deepEqual(await registry.verify(credentials.invocationId, credentials.callbackToken), {
    ok: false,
    reason: 'revoked',
  });
});

test('Redis decoding preserves a valid Host projection and fails closed on corrupt roots', () => {
  const fields = {
    recordSchemaVersion: '1',
    principalKind: 'ordinary',
    invocationId: 'fixture-invocation',
    callbackToken: 'fixture-token',
    catId: 'codex',
    userId: 'fixture-user',
    threadId: 'fixture-thread',
    sharedMcpContext: JSON.stringify(context),
  };
  const record = authRecordFromRedisHash(fields, new Set());
  assert.deepEqual(record.sharedMcpContext, context);
  fields.sharedMcpContext = JSON.stringify({ ...context, allowedWorkspaceDirs: [] });
  assert.equal(authRecordFromRedisHash(fields, new Set()), null);
});

test(
  'shared authority and revocation survive replacement of the Redis client and registry',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'f333-shared-principal');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisAuthInvocationBackend } = await import(
      '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js'
    );
    const namespace = createAuthTestNamespace('f333-shared-principal');
    const first = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: namespace });
    let credentials;
    try {
      const registry = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(first) });
      credentials = await registry.create(
        'fixture-user',
        'codex',
        'fixture-thread',
        undefined,
        undefined,
        undefined,
        undefined,
        'strict',
        undefined,
        context,
      );
    } finally {
      await first.quit();
    }
    const second = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: namespace });
    try {
      const registry = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(second) });
      const verified = await registry.verify(credentials.invocationId, credentials.callbackToken);
      assert.ok(verified.ok);
      assert.deepEqual(verified.record.sharedMcpContext, context);
      await registry.commitTerminal({
        invocationId: credentials.invocationId,
        disposition: 'revoked',
        endedAt: Date.now(),
        endReason: 'fixture-revoke',
      });
    } finally {
      await second.quit();
    }
    const third = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: namespace });
    try {
      const registry = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(third) });
      assert.deepEqual(await registry.verify(credentials.invocationId, credentials.callbackToken), {
        ok: false,
        reason: 'revoked',
      });
    } finally {
      await clearAuthTestNamespace(third, namespace);
      await third.quit();
    }
  },
);
