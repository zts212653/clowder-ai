/**
 * ToolEventLog Redis-backed tests (TD 2026-08-12: unbounded growth fix).
 *
 * The in-memory fake's zremrangebyrank / negative-index zrange are hand-rolled;
 * real Redis semantics must be verified directly (feedback_inmemory: pure
 * in-memory store tests are false-green for store-backed query patterns).
 *
 * Covers: per-thread cap trim, bounded tail read, sanitize roundtrip, and
 * self-healing of an oversized legacy key on first append.
 * 有 Redis → 真实验证；无 Redis → skip。
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function makeEvent(overrides = {}) {
  return {
    invocationId: 'inv-1',
    sessionId: 'sess-1',
    threadId: 'thread-R',
    catId: 'fable-5',
    toolName: 'Bash',
    timestamp: Date.now(),
    turnIndex: 0,
    status: 'success',
    summary: { command: 'echo hi' },
    ...overrides,
  };
}

describe('ToolEventLog (Redis)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let ToolEventLog;
  let redis;
  let connected = false;

  const TEST_KEY_PREFIX = 'td-toolevlog-test:';

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'ToolEventLog');
    const mod = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    ToolEventLog = mod.ToolEventLog;
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
    connected = true;
  });

  beforeEach(async () => {
    if (connected) await cleanupClientKeyspace(redis);
  });

  after(async () => {
    if (connected) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });

  it('caps per-thread events at maxEventsPerThread, keeping the newest', async () => {
    const eventLog = new ToolEventLog(redis, { maxEventsPerThread: 5 });
    for (let i = 0; i < 9; i++) {
      await eventLog.append(makeEvent({ timestamp: 1000 + i, turnIndex: i }));
    }
    const events = await eventLog.readByThread('thread-R');
    assert.equal(events.length, 5, 'real ZREMRANGEBYRANK must trim to cap');
    assert.deepEqual(
      events.map((e) => e.turnIndex),
      [4, 5, 6, 7, 8],
      'newest kept, oldest evicted (real Redis rank semantics)',
    );
  });

  it('readRecentByThread uses real negative-index ZRANGE semantics', async () => {
    const eventLog = new ToolEventLog(redis, { maxEventsPerThread: 100 });
    for (let i = 0; i < 7; i++) {
      await eventLog.append(makeEvent({ timestamp: 1000 + i, turnIndex: i }));
    }
    const tail = await eventLog.readRecentByThread('thread-R', 3);
    assert.deepEqual(
      tail.map((e) => e.turnIndex),
      [4, 5, 6],
      'tail window, ascending',
    );

    const over = await eventLog.readRecentByThread('thread-R', 50);
    assert.equal(over.length, 7, 'limit > size returns all (no wrap-around)');

    const zero = await eventLog.readRecentByThread('thread-R', 0);
    assert.equal(zero.length, 0, 'limit 0 returns empty, never full-range');
  });

  it('sanitizes oversized summaries end-to-end through real Redis', async () => {
    const eventLog = new ToolEventLog(redis, { maxEventsPerThread: 100 });
    await eventLog.append(makeEvent({ summary: { command: 'x'.repeat(300_000), _toolUseId: 'tu-r1' } }));

    const [event] = await eventLog.readByThread('thread-R');
    assert.ok(event.summary.command.length <= 1100, `stored command capped, got ${event.summary.command.length}`);
    assert.equal(event.summary._toolUseId, 'tu-r1');
    assert.equal(event.summary._truncated, true);
  });

  it('self-heals an oversized legacy key on first append (deploy-time convergence)', async () => {
    // Simulate the production 12,887-event legacy key with raw zadds (bypassing
    // the log's own guards, like the pre-fix writer did).
    const legacyCount = 50;
    for (let i = 0; i < legacyCount; i++) {
      await redis.zadd(
        'tool-event-log:thread-R',
        i + 1,
        JSON.stringify(makeEvent({ timestamp: 1000 + i, turnIndex: i, summary: { command: `legacy-${i}` } })),
      );
    }
    // Production keys keep score and the :seq INCR counter in sync — mirror
    // that, otherwise the next append would INCR from 1 and sort before the
    // legacy tail (a state that cannot occur outside this simulation).
    await redis.set('tool-event-log:thread-R:seq', String(legacyCount));

    const eventLog = new ToolEventLog(redis, { maxEventsPerThread: 10 });
    await eventLog.append(makeEvent({ timestamp: 5000, turnIndex: 999 }));

    const events = await eventLog.readByThread('thread-R');
    assert.equal(events.length, 10, 'one append trims the whole legacy backlog to cap');
    assert.equal(events.at(-1).turnIndex, 999, 'the new event survives at the tail');
  });

  it('updateSummary FIFO merge still works against real Redis after sanitize', async () => {
    const eventLog = new ToolEventLog(redis, { maxEventsPerThread: 100 });
    await eventLog.append(makeEvent({ toolName: 'search_evidence', summary: { resultCount: 3, nudgeEmitted: false } }));
    const ok = await eventLog.updateSummary(
      'thread-R',
      { toolName: 'search_evidence', catId: 'fable-5' },
      { resultStatus: 'hit', rawOutput: 'y'.repeat(80_000) },
    );
    assert.equal(ok, true);

    const [event] = await eventLog.readByThread('thread-R');
    assert.equal(event.summary.resultStatus, 'hit');
    assert.equal(event.summary._resultMerged, true);
    assert.ok(event.summary.rawOutput.length <= 1100, 'oversized patch capped through real WITHSCORES path');
    assert.equal(event.summary.resultCount, 3, 'original small fields survive the merge');
  });
});
