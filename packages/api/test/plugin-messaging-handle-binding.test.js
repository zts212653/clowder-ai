/**
 * K-1 / F288 — MessageHandle binding validation matrix (INV-21, INV-22, INV-23)
 *
 * Matrix-driven adversarial tests for getOrCreateMessageHandle. Each test
 * corresponds to a row in the fail-closed validation matrix (F288 spec):
 *
 * | #  | Resolution path                   | Behavior        | Error             |
 * |----|-----------------------------------|-----------------|-------------------|
 * | M1 | Index hit, all fields match       | Return existing | —                 |
 * | M2 | Index hit, kind ≠ message_handle  | Throw           | index corruption  |
 * | M3 | Index hit, messageId mismatch     | Throw           | index corruption  |
 * | M4 | Index hit, pluginInstanceId ≠     | Throw           | binding violation |
 * | M5 | Index hit, parentHandleId ≠       | Throw           | binding violation |
 * | M6 | Index hit, threadId ≠             | Throw           | binding violation |
 * | M7 | Index hit, userId ≠              | Throw           | binding violation |
 * | M8 | Index miss (no entry)             | Create new      | —                 |
 * | M9 | Index hit, record missing         | Create new      | —                 |
 *
 * Memory and Redis must produce identical outcomes (INV-22).
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, test } from 'node:test';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = `f288-handle-bind-${process.pid}:`;

/** @type {typeof import('../dist/domains/messaging/stores/memory.js')} */
let memory;
/** @type {typeof import('../dist/domains/messaging/handles.js')} */
let handlesMod;

beforeEach(async () => {
  memory = await import('../dist/domains/messaging/stores/memory.js');
  handlesMod = await import('../dist/domains/messaging/handles.js');
});

const SCOPE = { canSend: true, canSubscribe: true };

function base(overrides = {}) {
  return {
    handleId: 'mh_base',
    kind: 'message_handle',
    pluginInstanceId: 'inst-a',
    threadId: 'thread-1',
    userId: 'user-1',
    scope: SCOPE,
    messageId: 'msg-1',
    parentHandleId: 'th_parent',
    issuedAt: 1,
    ...overrides,
  };
}

// ── Memory store binding matrix ──

describe('MemoryHandleStore binding matrix (INV-21, INV-23)', () => {
  test('M1: all fields match → return existing', async () => {
    const store = new memory.MemoryHandleStore();
    const first = await store.getOrCreateMessageHandle(base());
    assert.equal(first.created, true);
    const second = await store.getOrCreateMessageHandle(base({ handleId: 'mh_retry' }));
    assert.equal(second.created, false);
    assert.equal(second.record.handleId, 'mh_base');
  });

  test('M2: wrong kind → throw index corruption (INV-23)', async () => {
    const store = new memory.MemoryHandleStore();
    store.records.set('th_wrong', {
      handleId: 'th_wrong',
      kind: 'thread_handle',
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
      issuedAt: 1,
    });
    store.messageIndex.set('msg-1', 'th_wrong');
    await assert.rejects(store.getOrCreateMessageHandle(base()), /handle index corruption.*kind=thread_handle/);
  });

  test('M3: messageId mismatch → throw index corruption', async () => {
    const store = new memory.MemoryHandleStore();
    await store.getOrCreateMessageHandle(base());
    store.records.set('mh_base', base({ messageId: 'msg-corrupt' }));
    await assert.rejects(
      store.getOrCreateMessageHandle(base({ handleId: 'mh_new' })),
      /handle index corruption.*messageId/,
    );
  });

  test('M4: pluginInstanceId mismatch → throw binding violation', async () => {
    const store = new memory.MemoryHandleStore();
    await store.getOrCreateMessageHandle(base());
    await assert.rejects(
      store.getOrCreateMessageHandle(base({ handleId: 'mh_x', pluginInstanceId: 'inst-b' })),
      /handle binding violation.*pluginInstanceId/,
    );
  });

  test('M5: parentHandleId mismatch → throw binding violation', async () => {
    const store = new memory.MemoryHandleStore();
    await store.getOrCreateMessageHandle(base());
    await assert.rejects(
      store.getOrCreateMessageHandle(base({ handleId: 'mh_x', parentHandleId: 'th_other' })),
      /handle binding violation.*parentHandleId/,
    );
  });

  test('M6: threadId mismatch → throw binding violation', async () => {
    const store = new memory.MemoryHandleStore();
    await store.getOrCreateMessageHandle(base());
    await assert.rejects(
      store.getOrCreateMessageHandle(base({ handleId: 'mh_x', threadId: 'thread-2' })),
      /handle binding violation.*threadId/,
    );
  });

  test('M7: userId mismatch → throw binding violation', async () => {
    const store = new memory.MemoryHandleStore();
    await store.getOrCreateMessageHandle(base());
    await assert.rejects(
      store.getOrCreateMessageHandle(base({ handleId: 'mh_x', userId: 'user-2' })),
      /handle binding violation.*userId/,
    );
  });

  test('M8: index miss → create new', async () => {
    const store = new memory.MemoryHandleStore();
    const result = await store.getOrCreateMessageHandle(base());
    assert.equal(result.created, true);
    assert.equal(result.record.messageId, 'msg-1');
  });

  test('M9: record missing → create new (recovery)', async () => {
    const store = new memory.MemoryHandleStore();
    await store.getOrCreateMessageHandle(base());
    store.records.delete('mh_base');
    const recovery = await store.getOrCreateMessageHandle(base({ handleId: 'mh_recovery' }));
    assert.equal(recovery.created, true);
    assert.equal(recovery.record.handleId, 'mh_recovery');
  });
});

// ── HandleService error wrapping ──

describe('HandleService wraps store binding errors as CONFLICT', () => {
  test('store binding violation → MessagingError CONFLICT', async () => {
    const cursors = new memory.MemoryCursorStore();
    const svc = new handlesMod.HandleService(new memory.MemoryHandleStore(), cursors);
    const p1 = await svc.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    const parent1 = await svc.resolveForSend('inst-a', {
      kind: 'thread_handle',
      handle: p1.handleId,
    });
    await svc.ensureMessageHandle(parent1, 'msg-wrap');

    const p2 = await svc.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-2',
      userId: 'user-1',
      scope: SCOPE,
    });
    const parent2 = await svc.resolveForSend('inst-a', {
      kind: 'thread_handle',
      handle: p2.handleId,
    });
    try {
      await svc.ensureMessageHandle(parent2, 'msg-wrap');
      assert.fail('expected CONFLICT');
    } catch (err) {
      assert.equal(err.name, 'MessagingError');
      assert.equal(err.code, 'CONFLICT');
      assert.match(err.message, /binding violation/);
    }
  });

  test('store index corruption → MessagingError CONFLICT', async () => {
    const store = new memory.MemoryHandleStore();
    const cursors = new memory.MemoryCursorStore();
    const svc = new handlesMod.HandleService(store, cursors);
    const p = await svc.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    const parent = await svc.resolveForSend('inst-a', {
      kind: 'thread_handle',
      handle: p.handleId,
    });
    await svc.ensureMessageHandle(parent, 'msg-corrupt');

    // Corrupt the stored record's messageId
    const indexedId = store.messageIndex.get('msg-corrupt');
    const record = store.records.get(indexedId);
    store.records.set(indexedId, { ...record, messageId: 'msg-other' });

    try {
      await svc.ensureMessageHandle(parent, 'msg-corrupt');
      assert.fail('expected CONFLICT');
    } catch (err) {
      assert.equal(err.name, 'MessagingError');
      assert.equal(err.code, 'CONFLICT');
      assert.match(err.message, /index corruption/);
    }
  });
});

// ── Redis store binding matrix ──

describe('RedisHandleStore binding matrix (INV-21, INV-22)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let connected = false;
  let RedisHandleStore;
  let MessagingKeys;

  let seq = 0;
  const nextId = (pfx) => `${pfx}-${Date.now()}-${(seq += 1)}`;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'HandleBindingMatrix');
    ({ RedisHandleStore } = await import('../dist/domains/messaging/stores/redis.js'));
    ({ MessagingKeys } = await import('../dist/domains/messaging/stores/redis-keys.js'));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({
      url: REDIS_URL,
      keyPrefix: TEST_KEY_PREFIX,
    });
    await redis.ping();
    connected = true;
  });

  after(async () => {
    if (connected) await redis.quit();
  });

  function rbase(messageId, overrides = {}) {
    return base({ handleId: nextId('mh'), messageId, ...overrides });
  }

  it('M1: all fields match → return existing', async () => {
    const store = new RedisHandleStore(redis);
    const msgId = nextId('msg');
    const c = rbase(msgId);
    const first = await store.getOrCreateMessageHandle(c);
    assert.equal(first.created, true);
    const second = await store.getOrCreateMessageHandle(rbase(msgId, { handleId: nextId('mh') }));
    assert.equal(second.created, false);
    assert.equal(second.record.handleId, first.record.handleId);
  });

  it('M2: wrong kind → throw index corruption', async () => {
    const store = new RedisHandleStore(redis);
    const msgId = nextId('msg');
    const badId = nextId('th');
    await redis.set(MessagingKeys.handleByMessage(msgId), badId);
    await redis.set(
      MessagingKeys.handle(badId),
      JSON.stringify({
        handleId: badId,
        kind: 'thread_handle',
        pluginInstanceId: 'inst-a',
        threadId: 'thread-1',
        userId: 'user-1',
        scope: SCOPE,
        issuedAt: 1,
      }),
    );
    await assert.rejects(store.getOrCreateMessageHandle(rbase(msgId)), /handle index corruption.*kind=thread_handle/);
  });

  it('M3: messageId mismatch → throw index corruption', async () => {
    const store = new RedisHandleStore(redis);
    const msgId = nextId('msg');
    const badId = nextId('mh');
    await redis.set(MessagingKeys.handleByMessage(msgId), badId);
    await redis.set(MessagingKeys.handle(badId), JSON.stringify(base({ handleId: badId, messageId: 'other' })));
    await assert.rejects(store.getOrCreateMessageHandle(rbase(msgId)), /handle index corruption.*messageId/);
  });

  it('M4: pluginInstanceId mismatch → throw binding violation', async () => {
    const store = new RedisHandleStore(redis);
    const msgId = nextId('msg');
    await store.getOrCreateMessageHandle(rbase(msgId));
    await assert.rejects(
      store.getOrCreateMessageHandle(rbase(msgId, { pluginInstanceId: 'inst-b' })),
      /handle binding violation.*pluginInstanceId/,
    );
  });

  it('M5: parentHandleId mismatch → throw binding violation', async () => {
    const store = new RedisHandleStore(redis);
    const msgId = nextId('msg');
    await store.getOrCreateMessageHandle(rbase(msgId));
    await assert.rejects(
      store.getOrCreateMessageHandle(rbase(msgId, { parentHandleId: 'th_other' })),
      /handle binding violation.*parentHandleId/,
    );
  });

  it('M6: threadId mismatch → throw binding violation', async () => {
    const store = new RedisHandleStore(redis);
    const msgId = nextId('msg');
    await store.getOrCreateMessageHandle(rbase(msgId));
    await assert.rejects(
      store.getOrCreateMessageHandle(rbase(msgId, { threadId: 'thread-2' })),
      /handle binding violation.*threadId/,
    );
  });

  it('M7: userId mismatch → throw binding violation', async () => {
    const store = new RedisHandleStore(redis);
    const msgId = nextId('msg');
    await store.getOrCreateMessageHandle(rbase(msgId));
    await assert.rejects(
      store.getOrCreateMessageHandle(rbase(msgId, { userId: 'user-2' })),
      /handle binding violation.*userId/,
    );
  });

  it('M9: record missing → create new (recovery)', async () => {
    const store = new RedisHandleStore(redis);
    const msgId = nextId('msg');
    const first = await store.getOrCreateMessageHandle(rbase(msgId));
    await redis.del(MessagingKeys.handle(first.record.handleId));
    const recovery = await store.getOrCreateMessageHandle(rbase(msgId));
    assert.equal(recovery.created, true);
    assert.notEqual(recovery.record.handleId, first.record.handleId);
  });
});
