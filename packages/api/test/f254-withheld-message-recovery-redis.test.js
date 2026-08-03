import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

describe('F254 withheld-message recovery Redis safety', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let applyRecoveryEntries;
  let validateRecoveryManifest;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F254 withheld-message recovery');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    ({ applyRecoveryEntries, validateRecoveryManifest } = await import(
      '../dist/scripts/f254-withheld-message-recovery/core.js'
    ));
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisMessageStore(redis);
  });

  after(async () => {
    if (!redis || !connected) return;
    await cleanupPrefixedRedisKeys(redis, ['msg:*', 'delivery-cursor:*', 'seen-cursor:*', 'mention-ack:*']);
    await redis.quit();
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['msg:*', 'delivery-cursor:*', 'seen-cursor:*', 'mention-ack:*']);
  });

  test('historical restore is persistent, idempotent, cursor-neutral, and pagination-stable', async () => {
    const threadId = 'thread_recovery';
    const userId = 'user-1';
    const catId = 'fable-5';
    const question = await store.append({
      userId,
      threadId,
      catId: null,
      content: '汉堡买到了吗？',
      mentions: [catId],
      timestamp: 100,
    });
    const later = await store.append({
      userId,
      threadId,
      catId: null,
      content: '谢谢宪宪',
      mentions: [catId],
      timestamp: 300,
    });
    const cursorKeys = [
      `delivery-cursor:${userId}:${catId}:${threadId}`,
      `seen-cursor:${userId}:${catId}:${threadId}`,
      `mention-ack:${userId}:${catId}:${threadId}`,
    ];
    for (const key of cursorKeys) await redis.set(key, later.id);
    const cursorsBefore = await redis.mget(...cursorKeys);
    const frontierBefore = await store.getLatestThreadMessageIdIncludingQueued(threadId);

    const content = '买到了，正在回家。';
    const manifest = validateRecoveryManifest({
      version: 1,
      incident: 'F254',
      generatedAt: '2026-07-12T02:00:00.000Z',
      cvoDecisionRef: '0001783820437069-000027-a6cebcce',
      entries: [
        {
          invocationId: 'inv-recovery-1',
          threadId,
          userId,
          catId,
          timestamp: 200,
          content,
          contentSha256: sha256(content),
          sourceProof: {
            transcriptPath: 'data/transcripts/thread_recovery/fable-5/events.live.jsonl',
            sessionId: 'session-1',
            firstEventNo: 1,
            lastEventNo: 4,
            terminalEventNo: 4,
            terminalKind: 'transcript_done',
          },
          metadata: { provider: 'anthropic', model: 'claude-fable-5', sessionId: 'cli-1' },
        },
      ],
    });

    const first = await applyRecoveryEntries({
      manifest,
      entries: manifest.entries,
      messageStore: store,
      recoveredAt: 500,
    });
    const second = await applyRecoveryEntries({
      manifest,
      entries: manifest.entries,
      messageStore: store,
      recoveredAt: 600,
    });

    assert.equal(first.created.length, 1);
    assert.equal(second.created.length, 0);
    assert.equal(second.alreadyPresent[0].id, first.created[0].id);
    assert.equal(await store.getLatestThreadMessageIdIncludingQueued(threadId), frontierBefore);
    assert.deepEqual(await redis.mget(...cursorKeys), cursorsBefore);

    const timeline = await store.getByThread(threadId, 10, userId);
    assert.deepEqual(
      timeline.map((message) => message.content),
      ['汉堡买到了吗？', '买到了，正在回家。', '谢谢宪宪'],
    );
    assert.deepEqual(
      (await store.getByThreadAfter(threadId, question.id, 10, userId)).map((message) => message.content),
      ['买到了，正在回家。', '谢谢宪宪'],
    );
    assert.deepEqual(
      (await store.getByThreadBefore(threadId, later.timestamp, 10, later.id, userId)).map(
        (message) => message.content,
      ),
      ['汉堡买到了吗？', '买到了，正在回家。'],
    );

    const restored = await store.getById(first.created[0].id);
    assert.equal(restored.extra.recovery.manifestSha256, manifest.manifestSha256);
    assert.equal(restored.extra.recovery.sourceProof.terminalEventNo, 4);
    assert.equal(restored.extra.recovery.sourceProof.terminalKind, 'transcript_done');
    assert.equal(await redis.ttl(`msg:${restored.id}`), -1, 'restored message must be persistent');
    assert.equal(
      await redis.ttl(`msg:idem:${userId}:${threadId}:f254-recovery:inv-recovery-1`),
      -1,
      'idempotency claim must be persistent',
    );
  });
});
