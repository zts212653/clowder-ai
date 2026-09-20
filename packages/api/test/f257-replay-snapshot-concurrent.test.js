/**
 * F257 Console 判据④ R4 — Redis-only concurrent fault drills for replay snapshots.
 *
 * Verifies that durable replay snapshots are written and deleted as a single
 * atomic lifecycle: a late writer cannot resurrect data after deleteTurn wins,
 * and deleteTurn cannot leave orphan snapshots if the writer won first.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('F257 replay snapshot atomic lifecycle - Redis', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let createRedisClient;
  let redis;
  let InjectionTraceStore;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'f257-replay-snapshot-concurrent');

    const shared = await import('@cat-cafe/shared/utils');
    createRedisClient = shared.createRedisClient;

    const storeMod = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    InjectionTraceStore = storeMod.InjectionTraceStore;

    redis = createRedisClient({ url: REDIS_URL, keyPrefix: 'f257-replay-race:' });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[f257-replay-snapshot-concurrent] Redis unreachable, skipping Redis drills');
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (redis && connected) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupClientKeyspace(redis);
  });

  function makeTurn(threadId, turnId) {
    const summary = {
      turnId,
      threadId,
      catId: 'opus',
      timestamp: Date.now(),
      segments: [],
      delivery: [],
      totalCharCount: 0,
      totalTokenEstimate: 0,
      totalSegmentsObserved: 0,
      totalSegmentsAbsent: 0,
      durationMs: 0,
    };
    const detail = {
      turnId,
      threadId,
      catId: 'opus',
      timestamp: summary.timestamp,
      sessionContentHash: null,
      turnContentHash: null,
      sessionCharCount: 0,
      sessionTokenEstimate: 0,
      turnCharCount: 0,
      turnTokenEstimate: 0,
      segments: [],
    };
    return { summary, detail };
  }

  function makeSnapshot(threadId, turnId, segmentId) {
    return {
      segmentId,
      threadId,
      turnId,
      timestamp: Date.now(),
      catId: 'opus',
      stage: 'session-init',
      pipelineStatus: 'fired',
      version: 1,
      content: 'rendered content',
      contentSourceKind: 'template',
      contentSourceRef: 'templates/S-test.md',
      templateVars: { VAR: 'value' },
      messageAnchorId: null,
      surroundingMessageIds: [],
      surroundingMessagesGap: null,
      ownerUserId: 'test-user',
    };
  }

  it('deleteTurn vs late persistReplaySnapshots race leaves no resurrected snapshot', async () => {
    const store = new InjectionTraceStore(redis);
    const threadId = 'race-thread';
    const turnId = 'race-turn';

    const { summary, detail } = makeTurn(threadId, turnId);
    await store.persist(summary, detail);

    // Simulate a fire-and-forget writer that has already crossed the event loop
    // by the time deleteTurn is issued.
    await store.deleteTurn(threadId, turnId);
    await store.persistReplaySnapshots(threadId, turnId, [makeSnapshot(threadId, turnId, 'S-late')]);

    const got = await store.getReplaySnapshot(threadId, turnId, 'S-late');
    assert.equal(got, null, 'late writer after delete must be suppressed by CAS');
  });

  it('concurrent deleteTurn and persistReplaySnapshots end with no snapshot', async () => {
    const store = new InjectionTraceStore(redis);
    const threadId = 'race-thread';
    const turnId = 'race-turn';

    const { summary, detail } = makeTurn(threadId, turnId);
    await store.persist(summary, detail);

    // Fire both operations at Redis without awaiting ordering.
    await Promise.all([
      store.deleteTurn(threadId, turnId),
      store.persistReplaySnapshots(threadId, turnId, [makeSnapshot(threadId, turnId, 'S-concurrent')]),
    ]);

    const got = await store.getReplaySnapshot(threadId, turnId, 'S-concurrent');
    assert.equal(got, null, 'delete must win the race without orphan snapshots');
  });

  it('repeated delete-then-write cycles do not leak snapshot keys', async () => {
    const store = new InjectionTraceStore(redis);
    const threadId = 'cycle-thread';
    const turnId = 'cycle-turn';

    for (let i = 0; i < 10; i++) {
      const { summary, detail } = makeTurn(threadId, `${turnId}-${i}`);
      await store.persist(summary, detail);
      await store.persistReplaySnapshots(summary.threadId, summary.turnId, [
        makeSnapshot(summary.threadId, summary.turnId, 'S1'),
      ]);
      await store.deleteTurn(summary.threadId, summary.turnId);
    }

    const keys = await redis.keys(`${redis.options?.keyPrefix ?? ''}replay-snapshot:cycle-thread:*`);
    assert.equal(keys.length, 0, 'no durable replay snapshot keys leaked');
  });

  it('deleteTurn isolates sibling turns in shared thread index', async () => {
    const store = new InjectionTraceStore(redis);
    const threadId = 'sibling-thread';

    const a = makeTurn(threadId, 'turn-a');
    a.summary.timestamp = 1000;
    a.detail.timestamp = 1000;
    const b = makeTurn(threadId, 'turn-b');
    b.summary.timestamp = 2000;
    b.detail.timestamp = 2000;

    await store.persist(a.summary, a.detail);
    await store.persist(b.summary, b.detail);
    await store.persistReplaySnapshots(threadId, 'turn-a', [makeSnapshot(threadId, 'turn-a', 'S-a')]);
    await store.persistReplaySnapshots(threadId, 'turn-b', [makeSnapshot(threadId, 'turn-b', 'S-b')]);

    await store.deleteTurn(threadId, 'turn-a');

    const { turnIds, total } = await store.listTurnIds(threadId);
    assert.equal(total, 1);
    assert.deepEqual(turnIds, ['turn-b']);

    const window = await store.queryWindow(threadId, 1500, 2500);
    assert.equal(window.length, 1);
    assert.equal(window[0].turnId, 'turn-b');

    assert.equal(await store.getSummary(threadId, 'turn-a'), null);
    assert.equal(await store.getReplaySnapshot(threadId, 'turn-a', 'S-a'), null);

    const bSummary = await store.getSummary(threadId, 'turn-b');
    assert.ok(bSummary);
    assert.equal(bSummary.turnId, 'turn-b');

    const bSnapshot = await store.getReplaySnapshot(threadId, 'turn-b', 'S-b');
    assert.ok(bSnapshot);
    assert.equal(bSnapshot.turnId, 'turn-b');
  });
});
