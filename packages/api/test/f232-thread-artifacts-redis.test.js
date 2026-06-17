/**
 * F232 AC-A6: Redis-backed thread artifacts aggregation.
 * Validates RedisMessageStore.getByThread (msg:thread:{id} sorted-set index) feeds the
 * aggregator correctly — coverage that in-memory stores cannot give (they iterate all +
 * filter, hiding Redis index selection / ordering / thread isolation). LL: feedback_inmemory.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('F232 thread artifacts — Redis-backed (AC-A6)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisMessageStore;
  let createRedisClient;
  let aggregateThreadArtifacts;
  let collectAllThreadMessages;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F232ThreadArtifacts');
    RedisMessageStore = (await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'))
      .RedisMessageStore;
    const aggMod = await import('../dist/domains/cats/services/agents/routing/thread-artifacts-aggregator.js');
    aggregateThreadArtifacts = aggMod.aggregateThreadArtifacts;
    collectAllThreadMessages = aggMod.collectAllThreadMessages;
    createRedisClient = (await import('@cat-cafe/shared/utils')).createRedisClient;
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisMessageStore(redis, { ttlSeconds: 60 });
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['msg:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
  });

  it('getByThread feeds aggregator: all rich-block artifacts retrieved via thread index, time-desc', async () => {
    const T = 'thread-f232-redis';
    // Real epoch timestamps: append prunes index entries with score < now - ttl,
    // so tiny synthetic timestamps (100, 200…) get dropped on insert.
    const base = Date.now();
    const rows = [
      { ts: base + 100, block: { id: 'b1', kind: 'file', v: 1, url: '/uploads/a.pdf', fileName: 'a.pdf' } },
      {
        ts: base + 200,
        block: {
          id: 'b2',
          kind: 'media_gallery',
          v: 1,
          items: [{ url: '/u/x.png', caption: 'x' }, { url: '/u/y.png' }],
        },
      },
      { ts: base + 300, block: { id: 'b3', kind: 'diff', v: 1, filePath: 'src/z.ts', diff: '@@' } },
      { ts: base + 400, block: { id: 'b4', kind: 'audio', v: 1, url: '/u/v.mp3', title: '语音' } },
      { ts: base + 500, block: { id: 'b5', kind: 'card', v: 1, title: 'ignored' } },
    ];
    for (const { ts, block } of rows) {
      await store.append({
        userId: 'u',
        catId: 'opus-48',
        content: '',
        mentions: [],
        timestamp: ts,
        threadId: T,
        extra: { rich: { v: 1, blocks: [block] } },
      });
    }

    const messages = await store.getByThread(T, 100);
    assert.equal(messages.length, 5, 'all 5 messages retrieved via Redis thread sorted-set index');

    const artifacts = aggregateThreadArtifacts({ messages, prTasks: [], fileLedger: [] });
    // file(1) + media(2 items) + diff(1) + audio(1) + card(0) = 5
    assert.equal(artifacts.length, 5);
    assert.equal(artifacts[0].type, 'audio', 'newest first (ts 400)');
    assert.equal(artifacts[artifacts.length - 1].type, 'file', 'oldest last (ts 100)');
    assert.ok(
      artifacts.every((a) => typeof a.sourceMessageId === 'string'),
      'sourceMessageId round-trips Redis hydration',
    );
    assert.deepEqual(artifacts.map((a) => a.type).sort(), ['audio', 'code', 'file', 'image', 'image']);
  });

  it('collectAllThreadMessages pages by effective order time: queued→delivered msg must not hide cross-page artifacts (P2 cloud review)', async () => {
    const T = 'thread-f232-queued-paging';
    const base = Date.now();
    // 四条消息各带一个 file artifact。effective score（deliveredAt ?? timestamp）排序：
    //   old(base+100) < gap(base+150) < queued(re-score base+300, 原始 ts base+120) < new(base+400)
    // queued 是 queued→delivered，markDelivered 把 zset score 推到 base+300，但其原始 timestamp
    // (base+120) < gap 的 score(base+150)。pageSize=2 时首页取最新两条 [queued, new]，游标落在 queued。
    // 若游标用原始 timestamp(base+120) 作上界，下一页 zrevrangebyscore(< base+120) 会跳过 gap(base+150)，
    // gap.pdf 的 artifact 从 GET /api/threads/:threadId/artifacts 漏聚合。必须用 effective score。
    const append = (ts, fileName, deliveryStatus) =>
      store.append({
        userId: 'u',
        catId: 'opus-48',
        content: '',
        mentions: [],
        timestamp: ts,
        threadId: T,
        ...(deliveryStatus ? { deliveryStatus } : {}),
        extra: {
          rich: { v: 1, blocks: [{ id: fileName, kind: 'file', v: 1, url: `/uploads/${fileName}`, fileName }] },
        },
      });

    await append(base + 100, 'old.pdf');
    await append(base + 150, 'gap.pdf');
    const queued = await append(base + 120, 'queued.pdf', 'queued');
    await append(base + 400, 'new.pdf');
    await store.markDelivered(queued.id, base + 300);

    const messages = await collectAllThreadMessages(store, T, undefined, 2);
    const names = messages.map((m) => m.extra?.rich?.blocks?.[0]?.fileName).sort();
    assert.deepEqual(
      names,
      ['gap.pdf', 'new.pdf', 'old.pdf', 'queued.pdf'],
      'all 4 messages collected across pages — gap.pdf (score between queued msg timestamp and its deliveredAt) must not be skipped',
    );

    const artifacts = aggregateThreadArtifacts({ messages, prTasks: [], fileLedger: [] });
    assert.deepEqual(
      artifacts.map((a) => a.name).sort(),
      ['gap.pdf', 'new.pdf', 'old.pdf', 'queued.pdf'],
      'gap.pdf artifact present in aggregation (not lost to pagination cursor bug)',
    );
  });

  it('thread index isolates: getByThread(other) does not leak this thread artifacts', async () => {
    await store.append({
      userId: 'u',
      catId: 'opus-48',
      content: '',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-A',
      extra: { rich: { v: 1, blocks: [{ id: 'b', kind: 'file', v: 1, url: '/u/a', fileName: 'a' }] } },
    });

    // thread-A has an artifact; thread-B index must not leak it
    const aArtifacts = aggregateThreadArtifacts({
      messages: await store.getByThread('thread-A', 100),
      prTasks: [],
      fileLedger: [],
    });
    assert.equal(aArtifacts.length, 1, 'thread-A has its own artifact');
    const other = await store.getByThread('thread-B', 100);
    assert.equal(other.length, 0);
    assert.equal(aggregateThreadArtifacts({ messages: other, prTasks: [], fileLedger: [] }).length, 0);
  });
});
