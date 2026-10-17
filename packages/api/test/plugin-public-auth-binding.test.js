import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MemoryAuthInvocationBackend } from '../dist/domains/cats/services/agents/invocation/MemoryAuthInvocationBackend.js';
import { RedisAuthInvocationBackend } from '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js';
import { authRecordFromRedisHash } from '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationRecord.js';

const binding = () => ({
  version: 1,
  entryId: 'entry-1',
  carrier: {
    version: 1,
    admissionId: 'admission-1',
    sourceMessageId: 'source-1',
    sourcePluginRevision: 1,
    pluginInstanceId: 'instance',
    packageDigest: 'digest',
    lifecycleRevision: 1,
    grantRevision: 0,
    contributionId: 'native',
    actionMethods: ['native.read'],
    targetCatId: 'astra',
    authorityRef: 'authority-1',
    authorityRevision: 'r1',
  },
});
const policy = () => ({
  mode: 'plugin_native',
  pluginInstanceId: 'instance',
  contributionId: 'native',
  actionMethods: ['native.read'],
});
const input = () => ({
  invocationId: 'child-1',
  callbackToken: 'token-1',
  userId: 'owner',
  threadId: 'thread',
  catId: 'astra',
  ownerAuthProvenance: 'unknown',
  originTriggerMessageId: 'source-1',
  toolExecutionPolicy: policy(),
  publicInvocationBinding: binding(),
  clientMessageIds: new Set(),
  createdAt: 1000,
});
const issue = (registry, value = binding(), overrides = {}) => {
  const r = { ...input(), ...overrides };
  return registry.create(
    r.userId,
    r.catId,
    r.threadId,
    undefined,
    r.a2aTriggerMessageId,
    r.toolExecutionPolicy,
    r.originTriggerMessageId,
    r.ownerAuthProvenance,
    r.managedWorkBinding,
    value,
  );
};
const raw = () => ({
  invocationId: 'child-1',
  callbackToken: 'token-1',
  userId: 'owner',
  threadId: 'thread',
  catId: 'astra',
  ownerAuthProvenance: 'unknown',
  originTriggerMessageId: 'source-1',
  toolExecutionPolicy: JSON.stringify(policy()),
  publicInvocationBinding: JSON.stringify(binding()),
  state: 'active',
  createdAt: '1000',
});
function redisFixture() {
  let writes = 0;
  let hash;
  const redis = {
    hgetall: async () => hash,
    get: async () => null,
    eval: async (_script, count, ...args) => {
      writes++;
      const fields = args.slice(count + 4);
      hash = Object.fromEntries(
        Array.from({ length: fields.length / 2 }, (_, i) => [fields[2 * i], fields[2 * i + 1]]),
      );
      return ['ok', ''];
    },
  };
  return { backend: new RedisAuthInvocationBackend(redis), redis, writes: () => writes, hash: () => hash };
}

test('public auth facade captures detached deeply frozen binding at credential creation', async () => {
  const registry = new InvocationRegistry();
  const value = binding();
  const pending = issue(registry, value);
  value.carrier.actionMethods.push('native.admin');
  value.entryId = 'changed';
  const credentials = await pending;
  const result = await registry.verify(credentials.invocationId, credentials.callbackToken);
  assert.equal(result.ok, true);
  assert.deepEqual(result.record.publicInvocationBinding, binding());
  assert.ok(Object.isFrozen(result.record.publicInvocationBinding.carrier.actionMethods));
});

test('public auth facade rejects malformed or executable binding without issuing credentials', async () => {
  let writes = 0;
  const registry = new InvocationRegistry({
    backend: {
      create: async () => {
        writes++;
      },
    },
  });
  const accessor = binding();
  Object.defineProperty(accessor, 'entryId', {
    enumerable: true,
    get() {
      throw new Error('getter must not run');
    },
  });
  for (const value of [
    null,
    {},
    { ...binding(), version: 2 },
    { ...binding(), entryId: '' },
    { ...binding(), extra: true },
    { ...binding(), carrier: {} },
    accessor,
  ]) {
    await assert.rejects(issue(registry, value), /public invocation binding/i);
  }
  assert.equal(writes, 0);
});

test('public auth facade rejects owner Work A2A and mismatched source target or policy', async () => {
  const cases = [
    { ownerAuthProvenance: 'strict' },
    { managedWorkBinding: { workId: 'w', attemptId: 'a' } },
    { a2aTriggerMessageId: 'a2a' },
    { userId: '' },
    { threadId: '' },
    { catId: 'codex' },
    { originTriggerMessageId: undefined },
    { originTriggerMessageId: 'other' },
    { toolExecutionPolicy: undefined },
    { toolExecutionPolicy: { ...policy(), pluginInstanceId: 'other' } },
    { toolExecutionPolicy: { ...policy(), actionMethods: ['native.admin', 'native.read'] } },
  ];
  for (const override of cases) await assert.rejects(issue(new InvocationRegistry(), binding(), override));
});

test('public auth memory backend detaches input carrier and policy before storing', async () => {
  const backend = new MemoryAuthInvocationBackend();
  const r = input();
  await backend.create(r);
  r.publicInvocationBinding.entryId = 'changed';
  r.publicInvocationBinding.carrier.actionMethods.push('native.admin');
  r.toolExecutionPolicy.actionMethods.push('native.admin');
  const record = await backend.getRecord('child-1');
  assert.deepEqual(record.publicInvocationBinding, binding());
  assert.deepEqual(record.toolExecutionPolicy, policy());
});

test('public auth memory returned records cannot erase or replace durable binding', async () => {
  const backend = new MemoryAuthInvocationBackend();
  await backend.create(input());
  for (const read of [
    () => backend.getRecord('child-1'),
    () => backend.peekRecord('child-1'),
    async () => (await backend.verifyLatest('child-1', 'token-1')).record,
    async () => (await backend.listActiveRecords())[0],
  ]) {
    const record = await read();
    Reflect.deleteProperty(record, 'publicInvocationBinding');
    Reflect.set(record, 'publicInvocationBinding', undefined);
    const current = await backend.getRecord('child-1');
    assert.deepEqual(current.publicInvocationBinding, binding());
  }
});

test('public auth memory rejects malformed direct input before replacing existing principal', async () => {
  const backend = new MemoryAuthInvocationBackend();
  const existing = input();
  delete existing.publicInvocationBinding;
  await backend.create(existing);
  await assert.rejects(backend.create({ ...input(), invocationId: 'loser', publicInvocationBinding: {} }));
  assert.equal((await backend.verifyLatest('child-1', 'token-1')).ok, true);
});

test('public auth Redis create includes binding in the single atomic create payload', async () => {
  const f = redisFixture();
  await f.backend.create(input());
  assert.equal(f.writes(), 1);
  assert.equal(typeof f.hash().publicInvocationBinding, 'string');
  assert.deepEqual(JSON.parse(f.hash().publicInvocationBinding), binding());
});

test('public auth Redis rejects invalid binding before any storage mutation', async () => {
  const f = redisFixture();
  await assert.rejects(f.backend.create({ ...input(), publicInvocationBinding: {} }));
  assert.equal(f.writes(), 0);
});

test('public auth Redis hash parsing restores frozen binding with exact source and policy', () => {
  const record = authRecordFromRedisHash(raw(), new Set());
  assert.ok(record);
  assert.deepEqual(record.publicInvocationBinding, binding());
  assert.ok(Object.isFrozen(record.publicInvocationBinding.carrier.actionMethods));
});

test('public auth Redis malformed present binding fails closed rather than restoring ordinary identity', () => {
  for (const value of [
    '',
    'null',
    'undefined',
    '{',
    '{}',
    JSON.stringify({ ...binding(), entryId: '' }),
    JSON.stringify({ ...binding(), carrier: {} }),
    JSON.stringify({ ...binding(), extra: true }),
  ]) {
    assert.equal(authRecordFromRedisHash({ ...raw(), publicInvocationBinding: value }, new Set()), null);
  }
});

test('public auth Redis mismatched or partial authority fails closed', () => {
  for (const override of [
    { catId: 'codex' },
    { originTriggerMessageId: '' },
    { userId: '' },
    { threadId: '' },
    { ownerAuthProvenance: 'strict' },
    { ownerAuthProvenance: 'invalid' },
    { a2aTriggerMessageId: 'other' },
    { managedWorkId: 'w', managedWorkAttemptId: 'a' },
    { toolExecutionPolicy: '' },
    { toolExecutionPolicy: JSON.stringify({ ...policy(), contributionId: 'other' }) },
  ]) {
    assert.equal(authRecordFromRedisHash({ ...raw(), ...override }, new Set()), null);
  }
});

test('public auth terminal records retain the original public identity', async () => {
  const registry = new InvocationRegistry();
  const credentials = await issue(registry);
  const result = await registry.commitTerminal({
    invocationId: credentials.invocationId,
    disposition: 'canceled',
    endedAt: 2000,
    endReason: 'cas_loser',
  });
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(result.record.publicInvocationBinding, binding());
});

test('public auth absent binding preserves ordinary native callback records', async () => {
  const registry = new InvocationRegistry();
  const credentials = await registry.create('owner', 'astra', 'thread', undefined, undefined, policy(), 'source-1');
  const ordinary = raw();
  delete ordinary.publicInvocationBinding;
  const record = authRecordFromRedisHash(ordinary, new Set());
  assert.ok(record);
  assert.equal(record.publicInvocationBinding, undefined);
  assert.equal((await registry.verify(credentials.invocationId, credentials.callbackToken)).ok, true);
});

test('public auth Redis create restores the same binding in a fresh backend instance', async () => {
  const f = redisFixture();
  await f.backend.create(input());
  const restored = new RedisAuthInvocationBackend(f.redis);
  const record = await restored.peekRecord('child-1');
  assert.deepEqual(record.publicInvocationBinding, binding());
  assert.deepEqual(record.toolExecutionPolicy, policy());
  assert.equal(record.originTriggerMessageId, 'source-1');
  assert.equal(record.state, 'active');
});

test('public auth Redis freezes input identity before awaited latest-slot lookup', async () => {
  const f = redisFixture();
  const original = input();
  f.redis.get = async () => {
    original.invocationId = 'changed-child';
    original.userId = 'changed-user';
    original.publicInvocationBinding.carrier.actionMethods.push('native.admin');
    return null;
  };
  await f.backend.create(original);
  assert.equal(f.hash().invocationId, 'child-1');
  assert.equal(f.hash().userId, 'owner');
  assert.deepEqual(JSON.parse(f.hash().publicInvocationBinding), binding());
});

test('public auth terminal result cannot erase the persisted public identity', async () => {
  const backend = new MemoryAuthInvocationBackend();
  await backend.create(input());
  for (const attempt of [1, 2]) {
    const result = await backend.commitTerminal({
      invocationId: 'child-1',
      disposition: 'canceled',
      endedAt: 2000,
      endReason: 'cas_loser',
    });
    assert.equal(result.outcome, attempt === 1 ? 'committed' : 'already_terminal');
    Reflect.deleteProperty(result.record, 'publicInvocationBinding');
    assert.deepEqual((await backend.peekRecord('child-1')).publicInvocationBinding, binding());
  }
});
