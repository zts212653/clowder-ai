import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  canonicalizeAppendMessageInput,
  MessageStore,
  mergeMessageExtra,
} from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { safeParseExtra, serializeExtra } from '../dist/domains/cats/services/stores/redis/redis-message-parsers.js';
import { MessageKeys } from '../dist/domains/cats/services/stores/redis-keys/message-keys.js';
import { projectOwnedPluginTasks } from '../dist/domains/plugin/host-surface/task/plugin-task-read.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const receipt = { v: 1, sourceRef: 'message:source', catId: 'codex61-sol', ownerAuthProvenance: 'strict' };
const task = {
  id: 'original-task',
  kind: 'work',
  userId: 'owner',
  threadId: 'original-thread',
  ownerCatId: 'codex61-sol',
  subjectKey: 'original-subject',
  title: 'Original work',
  status: 'todo',
  why: 'Original owner request',
  createdBy: 'codex61-sol',
  createdAt: 1,
  updatedAt: 1,
  entrustedWork: {
    revision: 3,
    artifactRefs: ['/uploads/original.md'],
    closure: { state: 'open' },
    admission: { basis: 'authorized_source', sourceRefs: ['message:source'], authorityRef: 'message:receipt' },
  },
};
const expected = { receiptRef: 'message:receipt', sourceRef: 'message:source', catId: 'codex61-sol' };
const legacyKeys = [
  'collectiveOwnerAdmissionV1',
  'collectiveAuthorizationInvalid',
  'collectiveWorkInvocationV1',
  'collectiveWorkDelegationV1',
];

function hash(extra = { collectiveOwnerAdmissionV1: receipt }) {
  return {
    id: 'receipt',
    userId: 'owner',
    threadId: 'original-thread',
    catId: '',
    from: JSON.stringify({ kind: 'user', userId: 'owner' }),
    content: 'Original owner receipt',
    timestamp: '1',
    mentions: '[]',
    extra: serializeExtra(extra),
  };
}
function storeFor(raw) {
  return new RedisMessageStore({ options: {}, hgetall: async () => structuredClone(raw) });
}
async function project(store) {
  const [item] = await projectOwnedPluginTasks([task], 'owner', undefined, new Map(), store);
  return item.entrustedWork.admission.hostReceipt;
}

test('legacy receipt survives the actual RedisMessageStore hydration before Host projection', async () => {
  const raw = hash();
  assert.deepEqual(safeParseExtra(raw.extra)?.collectiveOwnerAdmissionV1, receipt);
  assert.deepEqual(await project(storeFor(raw)), expected);
  assert.equal(task.entrustedWork.revision, 3);
  assert.equal(task.entrustedWork.dataController, undefined);
});

for (const [label, extra] of [
  ['malformed receipt', { collectiveOwnerAdmissionV1: { ...receipt, catId: '' } }],
  ['null receipt', { collectiveOwnerAdmissionV1: null }],
  ...[true, false, null, { reason: 'revoked' }].map((marker) => [
    `explicit invalid marker ${JSON.stringify(marker)}`,
    { collectiveOwnerAdmissionV1: receipt, collectiveAuthorizationInvalid: marker },
  ]),
  ['retired invocation mixed into receipt', { collectiveOwnerAdmissionV1: receipt, collectiveWorkInvocationV1: {} }],
  ['retired delegation mixed into receipt', { collectiveOwnerAdmissionV1: receipt, collectiveWorkDelegationV1: {} }],
]) {
  test(`${label} remains invalid after persistence hydration`, async () => {
    const raw = hash(extra);
    assert.equal(safeParseExtra(raw.extra)?.collectiveAuthorizationInvalid, true);
    assert.equal(await project(storeFor(raw)), undefined);
  });
}

for (const [label, patch] of [
  ['foreign owner', { userId: 'other' }],
  ['foreign thread', { threadId: 'other' }],
  ['agent author', { catId: 'codex61-sol', from: JSON.stringify({ kind: 'agent', catId: 'codex61-sol' }) }],
  ['foreign sender', { from: JSON.stringify({ kind: 'user', userId: 'other' }) }],
  ['external source', { source: JSON.stringify({ connector: 'external', label: 'external', icon: 'x' }) }],
  ['invalid source', { source: '{' }],
  ['deleted', { deletedAt: '2' }],
  ['tombstone', { _tombstone: '1' }],
  ['recall', { recall: JSON.stringify({ version: 1, exposure: 'none', recalledAt: 2 }) }],
  [
    'wrong source receipt',
    { extra: serializeExtra({ collectiveOwnerAdmissionV1: { ...receipt, sourceRef: 'message:other' } }) },
  ],
  ['wrong cat receipt', { extra: serializeExtra({ collectiveOwnerAdmissionV1: { ...receipt, catId: 'other' } }) }],
]) {
  test(`Host still refuses ${label} through the real hydration seam`, async () => {
    assert.equal(await project(storeFor({ ...hash(), ...patch })), undefined);
  });
}

test('legacy receipt hydration does not restore retired invocation or delegation data', () => {
  const extra = safeParseExtra(serializeExtra({ collectiveWorkInvocationV1: {}, collectiveWorkDelegationV1: {} }));
  assert.equal(extra?.collectiveWorkInvocationV1, undefined);
  assert.equal(extra?.collectiveWorkDelegationV1, undefined);
});

for (const key of legacyKeys) {
  test(`generic writers cannot mint or replace legacy ${key}`, () => {
    const patch = { [key]: key === 'collectiveOwnerAdmissionV1' ? receipt : true };
    assert.throws(
      () =>
        canonicalizeAppendMessageInput({
          userId: 'owner',
          from: { kind: 'user', userId: 'owner' },
          content: 'new',
          mentions: [],
          timestamp: 1,
          extra: patch,
        }),
      /read.only legacy/i,
    );
    assert.equal(mergeMessageExtra(undefined, patch), undefined);
    const store = new MessageStore();
    const message = store.append({
      userId: 'owner',
      from: { kind: 'user', userId: 'owner' },
      content: 'Current message',
      mentions: [],
      timestamp: 1,
    });
    store.updateExtra(message.id, patch);
    assert.equal(store.getById(message.id).extra?.[key], undefined);
    const original = { collectiveOwnerAdmissionV1: receipt, collectiveAuthorizationInvalid: true };
    assert.deepEqual(mergeMessageExtra(original, { ...patch, isExplicitPost: true }), {
      ...original,
      isExplicitPost: true,
    });
  });
}

test(
  'isolated Redis old hash remains readable and generic patches preserve its receipt',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'legacy-collective-receipt');
    const { default: Redis } = await import('ioredis');
    const redis = new Redis(process.env.REDIS_URL, {
      keyPrefix: `test:legacy-receipt:${randomUUID()}:`,
      maxRetriesPerRequest: 1,
    });
    const key = MessageKeys.detail('receipt');
    try {
      // This is an old persisted hash, never a new legacy append authorization path.
      await redis.hset(key, hash());
      const store = new RedisMessageStore(redis);
      assert.deepEqual(await project(store), expected);
      await store.updateExtra('receipt', {
        collectiveOwnerAdmissionV1: { ...receipt, sourceRef: 'message:other' },
        isExplicitPost: true,
      });
      assert.deepEqual(await project(store), expected);
      assert.equal((await store.getById('receipt')).extra.isExplicitPost, true);
      await redis.hset(key, hash({ collectiveOwnerAdmissionV1: receipt, collectiveAuthorizationInvalid: true }));
      await store.updateExtra('receipt', { collectiveAuthorizationInvalid: false, isExplicitPost: true });
      assert.equal(await project(store), undefined);
    } finally {
      await redis.del(key);
      await redis.quit();
    }
  },
);
