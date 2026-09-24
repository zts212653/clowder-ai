import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authRecordFromRedisHash } from '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationRecord.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { safeParseExtra } from '../dist/domains/cats/services/stores/redis/redis-message-parsers.js';

const receipt = { v: 1, sourceRef: 'message:source-A', catId: 'codex-astra', ownerAuthProvenance: 'strict' };
const trigger = { v: 1, taskId: 'work', observedRevision: 1 };
const input = {
  from: { kind: 'user', userId: 'owner' },
  userId: 'owner',
  threadId: 'private',
  content: 'Owner receipt',
  mentions: [],
  timestamp: 1,
};

test('generic Message mutations cannot forge or replace persisted owner admission and Task invocation', async () => {
  const store = new MessageStore();
  const admitted = store.append({ ...input, extra: { collectiveOwnerAdmissionV1: receipt } });
  await store.updateExtra(admitted.id, {
    collectiveOwnerAdmissionV1: { ...receipt, sourceRef: 'message:B' },
    collectiveAuthorizationInvalid: true,
  });
  assert.deepEqual(store.getById(admitted.id).extra.collectiveOwnerAdmissionV1, receipt);
  assert.equal(store.getById(admitted.id).extra.collectiveAuthorizationInvalid, undefined);
  const plain = store.append({ ...input, timestamp: 2 });
  await store.updateExtra(plain.id, { collectiveOwnerAdmissionV1: receipt, collectiveWorkInvocationV1: trigger });
  assert.equal(store.getById(plain.id).extra?.collectiveOwnerAdmissionV1, undefined);
  assert.equal(store.getById(plain.id).extra?.collectiveWorkInvocationV1, undefined);
  assert.throws(
    () =>
      store.append({
        ...input,
        from: { kind: 'agent', catId: 'codex-astra' },
        extra: { collectiveOwnerAdmissionV1: receipt },
      }),
    /Host-owned/,
  );
  assert.throws(
    () =>
      store.append({
        ...input,
        from: { kind: 'external', connectorId: 'collective' },
        source: { connector: 'collective', label: 'external' },
        extra: { collectiveOwnerAdmissionV1: receipt },
      }),
    /Host-owned/,
  );
  for (const from of [
    { kind: 'user', userId: 'owner' },
    { kind: 'agent', catId: 'codex-astra' },
    { kind: 'system', service: 'other' },
  ]) {
    assert.throws(
      () => store.append({ ...input, from, extra: { collectiveWorkInvocationV1: trigger } }),
      /canonical system producer/,
    );
  }
  assert.ok(
    store.append({
      ...input,
      timestamp: 3,
      from: { kind: 'system', service: 'collective-work' },
      extra: { collectiveWorkInvocationV1: trigger },
    }),
  );
  const redis = new RedisMessageStore({
    options: {},
    eval() {
      throw new Error('Invalid receipt reached Redis');
    },
  });
  await assert.rejects(
    redis.append({
      ...input,
      from: { kind: 'agent', catId: 'codex-astra' },
      extra: { collectiveOwnerAdmissionV1: receipt },
    }),
    /Host-owned/,
  );
});

test('Redis extra parsing preserves valid authority and marks corrupt carriers so Work fails closed', () => {
  assert.deepEqual(safeParseExtra(JSON.stringify({ collectiveOwnerAdmissionV1: receipt })), {
    collectiveOwnerAdmissionV1: receipt,
  });
  assert.deepEqual(safeParseExtra(JSON.stringify({ collectiveWorkInvocationV1: trigger })), {
    collectiveWorkInvocationV1: trigger,
  });
  for (const value of [
    { collectiveOwnerAdmissionV1: { ...receipt, ownerAuthProvenance: 'unknown' } },
    { collectiveOwnerAdmissionV1: { ...receipt, sourceRef: 'other' } },
    { collectiveWorkInvocationV1: { ...trigger, observedRevision: -1 } },
  ])
    assert.deepEqual(safeParseExtra(JSON.stringify(value)), { collectiveAuthorizationInvalid: true });
});

test('persisted invocation scope cannot lose its public grant, become owner strict, or retarget after restart', () => {
  const source = {
    serviceInstanceId: 'svc_100000000000',
    collectiveId: 'col_100000000000',
    connectionId: 'con_100000000000',
    eventId: 'evt_100000000000',
    location: { channelId: 'A' },
    catId: 'codex-astra',
    participationRevision: 1,
    actor: { kind: 'human', humanId: 'human_guest00000', displayName: 'Guest' },
  };
  const fields = {
    invocationId: 'inv',
    callbackToken: 'token',
    userId: 'owner',
    catId: source.catId,
    threadId: 'public',
    ownerAuthProvenance: 'unknown',
    originTriggerMessageId: 'source-A',
    toolExecutionPolicy: JSON.stringify({ mode: 'collective_participation' }),
    executionGrant: JSON.stringify({ kind: 'collective-participation', source, originTriggerMessageId: 'source-A' }),
  };
  assert.deepEqual(authRecordFromRedisHash(fields, new Set()).executionGrant.source, source);
  for (const delta of [
    { ownerAuthProvenance: 'strict' },
    { originTriggerMessageId: 'source-B' },
    { catId: 'opus' },
    { executionGrant: '{broken' },
    { executionGrant: '' },
    { toolExecutionPolicy: '' },
    { managedWorkId: 'work', managedWorkAttemptId: 'attempt' },
    {
      collectiveWorkBinding: JSON.stringify({
        ...trigger,
        sourceRef: 'message:source-A',
        authorityRef: 'message:owner',
      }),
    },
  ])
    assert.equal(authRecordFromRedisHash({ ...fields, ...delta }, new Set()), null, JSON.stringify(delta));
});
