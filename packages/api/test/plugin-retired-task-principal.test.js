import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryAuthInvocationBackend } from '../dist/domains/cats/services/agents/invocation/MemoryAuthInvocationBackend.js';
import { authRecordFromRedisHash } from '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationRecord.js';

const principal = {
  invocationId: 'retired-task',
  callbackToken: 'token',
  userId: 'owner',
  catId: 'codex',
  threadId: 'thread',
  ownerAuthProvenance: 'unknown',
  createdAt: Date.now(),
  clientMessageIds: new Set(),
};
test('retired Task credentials cannot enter the ordinary memory authentication lane', async () => {
  const backend = new MemoryAuthInvocationBackend();
  for (const pluginTaskBinding of [undefined, {}, { version: 2, taskId: 'old-task' }]) {
    await assert.rejects(backend.create({ ...principal, pluginTaskBinding }));
    assert.equal((await backend.verify(principal.invocationId, principal.callbackToken)).ok, false);
  }
  await assert.rejects(backend.create({ ...principal, publicInvocationBinding: {} }));
  await backend.create(principal);
  assert.equal((await backend.verify(principal.invocationId, principal.callbackToken)).ok, true);
});
test('Redis rejects retired or partially missing Task envelopes instead of normalizing them to ordinary', () => {
  const fields = Object.fromEntries(
    Object.entries(principal)
      .filter(([key]) => key !== 'clientMessageIds')
      .map(([k, v]) => [k, String(v)]),
  );
  for (const legacy of [
    { pluginTaskBinding: '{}' },
    { publicInvocationBinding: '{}' },
    { recordSchemaVersion: '1', principalKind: 'public_plugin' },
    { pluginTaskBindingVersion: '2' },
    { recordSchemaVersion: '1', principalKind: 'plugin_task' },
    { recordSchemaVersion: '1', principalKind: 'plugin_task', pluginTaskBinding: '{}', pluginTaskBindingVersion: '2' },
    { recordSchemaVersion: '1', principalKind: 'ordinary', pluginTaskBinding: '{}' },
  ])
    assert.equal(authRecordFromRedisHash({ ...fields, ...legacy }, new Set()), null);
  assert.equal(
    authRecordFromRedisHash({ ...fields, recordSchemaVersion: '1', principalKind: 'ordinary' }, new Set()).invocationId,
    principal.invocationId,
  );
});
