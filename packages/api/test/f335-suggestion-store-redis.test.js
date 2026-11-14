import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { RedisSuggestionStore } from '../dist/domains/suggestions/RedisSuggestionStore.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe-f335-suggestion-test:';

function record(id, overrides = {}) {
  return {
    id,
    userId: 'user-operator',
    threadId: 'thread_watch',
    messageId: `msg-${id}`,
    catId: 'fable-5',
    byline: 'cat',
    kind: 'video-comments',
    kindLabel: '添加视频批注',
    label: '添加 7 条视频批注',
    params: { comments: 7 },
    state: 'open',
    undo: 'undo',
    receiptOnly: false,
    events: [{ type: 'offered', at: 1 }],
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 10,
    ...overrides,
  };
}

describe('F335 RedisSuggestionStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let connected = false;
  let store;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F335 RedisSuggestionStore');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    await redis.quit().catch(() => {});
  });

  beforeEach(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    store = new RedisSuggestionStore(redis);
  });

  it('creates one row per message, atomically', async () => {
    const [a, b] = await Promise.all([
      store.create(record('a', { messageId: 'msg-shared' })),
      store.create(record('b', { messageId: 'msg-shared' })),
    ]);
    const kinds = [a.kind, b.kind].sort();
    assert.deepEqual(kinds, ['created', 'message_taken']);
    const taken = a.kind === 'message_taken' ? a : b;
    assert.ok(['a', 'b'].includes(taken.existingId));
    assert.equal((await store.listThread('thread_watch', 10)).length, 1);
  });

  it('swaps only from the expected revision and never expires a row', async () => {
    await store.create(record('a'));
    const first = await store.swap({ ...record('a'), state: 'applying', revision: 1 }, 0);
    const second = await store.swap({ ...record('a'), state: 'applying', revision: 1 }, 0);
    assert.deepEqual([first.kind, second.kind], ['swapped', 'conflict']);
    assert.equal((await store.get('a')).state, 'applying');
    assert.equal((await store.swap({ ...record('zzz'), revision: 1 }, 0)).kind, 'missing');
    for (const key of await redis.keys(`${KEY_PREFIX}*`)) {
      assert.equal(await redis.ttl(key.slice(KEY_PREFIX.length)), -1, `${key} must be persistent (TTL=0)`);
    }
  });

  it('lists a thread and a person’s kind newest first, and the kinds the person has seen', async () => {
    await store.create(record('old', { createdAt: 1 }));
    await store.create(record('new', { createdAt: 5 }));
    await store.create(record('task', { createdAt: 3, kind: 'scheduled-task' }));
    await store.create(record('elsewhere', { createdAt: 9, threadId: 'thread_other', userId: 'someone' }));
    assert.deepEqual(
      (await store.listThread('thread_watch', 10)).map((row) => row.id),
      ['new', 'task', 'old'],
    );
    assert.deepEqual(
      (await store.listUserKind('user-operator', 'video-comments', 10)).map((row) => row.id),
      ['new', 'old'],
    );
    assert.deepEqual(await store.listUserKinds('user-operator'), ['scheduled-task', 'video-comments']);
  });

  it('keeps hidden kinds per cat until restored', async () => {
    await store.hide('user-operator', { catId: 'codex61-sol', kind: 'video-comments', byline: 'watcher', hiddenAt: 7 });
    assert.equal(await store.isHidden('user-operator', 'codex61-sol', 'video-comments'), true);
    assert.equal(await store.isHidden('user-operator', 'fable-5', 'video-comments'), false);
    assert.deepEqual(await store.listHidden('user-operator'), [
      { catId: 'codex61-sol', kind: 'video-comments', byline: 'watcher', hiddenAt: 7 },
    ]);
    assert.equal(await store.unhide('user-operator', 'codex61-sol', 'video-comments'), true);
    assert.deepEqual(await store.listHidden('user-operator'), []);
  });
  it('moves the per-kind counts and the open set in the same step as the record', async () => {
    await store.create(record('a', { expiresAt: 10 }), 'offered');
    await store.create(record('b', { expiresAt: 20 }), 'offered');
    await store.create(record('r', { receiptOnly: true, state: 'applied' }));
    assert.deepEqual(await store.kindCounts('user-operator', 'video-comments'), { offered: 2 });
    assert.equal(await store.countOpen('user-operator', 'video-comments'), 2);
    assert.deepEqual(
      (await store.listOpenDue('user-operator', 'video-comments', 15, 10)).map((row) => row.id),
      ['a'],
    );
    const lost = await store.swap(
      { ...record('a', { expiresAt: 10 }), state: 'dismissed', revision: 8 },
      7,
      'dismissed',
    );
    assert.equal(lost.kind, 'conflict');
    assert.deepEqual(
      await store.kindCounts('user-operator', 'video-comments'),
      { offered: 2 },
      'a lost race counts nothing',
    );
    await store.swap({ ...record('a', { expiresAt: 10 }), state: 'dismissed', revision: 1 }, 0, 'dismissed');
    assert.deepEqual(await store.kindCounts('user-operator', 'video-comments'), { offered: 2, dismissed: 1 });
    assert.equal(await store.countOpen('user-operator', 'video-comments'), 1);
    await store.swap({ ...record('a', { expiresAt: 10 }), state: 'open', revision: 2 }, 1, 'restored');
    assert.equal(await store.countOpen('user-operator', 'video-comments'), 2, 'a restored pill is open again');
  });
  it('keeps the desk set in step with the record: on while pending or shown and open, off once settled', async () => {
    const work = { contentRef: 'work:sheet', ownerRevision: 1 };
    const brought = record('w', {
      kind: 'brought-work',
      kindLabel: '带来的作品',
      desk: { sentence: '照他的头像画就行。', work, status: 'pending' },
      createdAt: 5,
    });
    await store.create(brought, 'offered');
    await store.create(record('o', { createdAt: 6, expiresAt: 100 }), 'offered');
    assert.deepEqual(
      (await store.listDesk('user-operator', 10)).map((row) => row.id),
      ['w'],
      'an offer is not on the desk until the desk carries it',
    );
    assert.deepEqual(
      (await store.listOpen('user-operator', 'video-comments', 10)).map((row) => row.id),
      ['o'],
    );
    await store.swap(
      { ...record('o', { createdAt: 6, expiresAt: 100 }), desk: { status: 'shown', shownAt: 7 }, revision: 1 },
      0,
    );
    assert.deepEqual(
      (await store.listDesk('user-operator', 10)).map((row) => row.id),
      ['w', 'o'],
    );
    await store.swap(
      {
        ...record('o', { createdAt: 6, expiresAt: 100 }),
        state: 'applied',
        desk: { status: 'shown', shownAt: 7 },
        revision: 2,
      },
      1,
      'applied',
    );
    assert.deepEqual(
      (await store.listDesk('user-operator', 10)).map((row) => row.id),
      ['w'],
      'applied in the page: off the desk in the same step',
    );
    const lost = await store.swap(
      { ...brought, state: 'ignored', desk: { ...brought.desk, status: 'settled', outcome: 'saved' }, revision: 5 },
      4,
      'ignored',
    );
    assert.equal(lost.kind, 'conflict');
    assert.equal((await store.listDesk('user-operator', 10)).length, 1, 'a lost race leaves it on the desk');
    await store.swap(
      { ...brought, state: 'ignored', desk: { ...brought.desk, status: 'settled', outcome: 'saved' }, revision: 1 },
      0,
      'ignored',
    );
    assert.deepEqual(await store.listDesk('user-operator', 10), []);
    assert.deepEqual(await store.kindCounts('user-operator', 'brought-work'), { offered: 1, ignored: 1 });
  });
});
