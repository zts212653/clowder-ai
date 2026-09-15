/**
 * F254 FreshnessAttentionEventLog Tests (Phase B — B0)
 *
 * Tests the append-only event log for freshness attention events.
 * This log serves as the communication channel between the MCP tool layer
 * (B1/B2 notice delivery) and the harness layer (B3/B4 re-invoke decisions).
 *
 * Events use a closed union type with kind discriminator:
 * held_decision | forward_decision | notice_attached | notice_implicit_acked |
 * notice_deferred | reinvoke_triggered | reinvoke_skipped
 *
 * Redis-backed: uses test:redis infrastructure (port 6398, DB 15).
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('F254 FreshnessAttentionEventLog', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let FreshnessAttentionEventLog;
  let createRedisClient;
  let redis;
  let log;
  let connected = false;

  const KEY_PATTERNS = ['freshness:events:*'];

  const baseEvent = {
    threadId: 'thread-f254-b0-test',
    catId: 'opus',
    invocationId: 'inv-001',
    timestamp: 1700000000000,
  };

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F254 AttentionEventLog');

    const logModule = await import('../dist/domains/cats/services/freshness/FreshnessAttentionEventLog.js');
    FreshnessAttentionEventLog = logModule.FreshnessAttentionEventLog;

    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    // ioredis auto-connects; verify with ping
    await redis.ping();
    connected = true;

    log = new FreshnessAttentionEventLog(redis);
  });

  beforeEach(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
    await redis.quit();
  });

  // --- append + query ---

  it('appends a notice_attached event and queries by invocationId', async () => {
    const event = {
      ...baseEvent,
      kind: 'notice_attached',
      toolName: 'search_evidence',
      unseenSenders: ['user'],
      noticeId: 'notice-001',
      maxMessageId: '0000000000000010-000001-aaaaaaaa',
    };

    await log.append(event);

    const results = await log.queryByInvocation(baseEvent.invocationId);
    assert.equal(results.length, 1);
    assert.equal(results[0].kind, 'notice_attached');
    assert.equal(results[0].noticeId, 'notice-001');
    assert.deepEqual(results[0].unseenSenders, ['user']);
  });

  it('appends multiple events and returns them in order', async () => {
    await log.append({
      ...baseEvent,
      kind: 'notice_attached',
      toolName: 'search_evidence',
      unseenSenders: ['user'],
      noticeId: 'notice-001',
      maxMessageId: '0000000000000010-000001-aaaaaaaa',
      timestamp: 1700000000000,
    });

    await log.append({
      ...baseEvent,
      kind: 'notice_implicit_acked',
      noticeIds: ['notice-001'],
      ackedVia: 'seenCursor_advance',
      timestamp: 1700000001000,
    });

    const results = await log.queryByInvocation(baseEvent.invocationId);
    assert.equal(results.length, 2);
    assert.equal(results[0].kind, 'notice_attached');
    assert.equal(results[1].kind, 'notice_implicit_acked');
  });

  it('queries only return events for the specified invocationId', async () => {
    await log.append({
      ...baseEvent,
      invocationId: 'inv-001',
      kind: 'notice_attached',
      toolName: 'list_recent',
      unseenSenders: ['codex'],
      noticeId: 'notice-001',
      maxMessageId: '0000000000000010-000001-aaaaaaaa',
    });

    await log.append({
      ...baseEvent,
      invocationId: 'inv-002',
      kind: 'forward_decision',
      toolName: 'post_message',
      reason: 'no_unseen',
    });

    const inv1 = await log.queryByInvocation('inv-001');
    const inv2 = await log.queryByInvocation('inv-002');
    assert.equal(inv1.length, 1);
    assert.equal(inv2.length, 1);
    assert.equal(inv1[0].kind, 'notice_attached');
    assert.equal(inv2[0].kind, 'forward_decision');
  });

  it('proves a half-open owner-scoped replay window and rejects coverage gaps', async () => {
    const now = 1700000065000;
    const settledWindowEnd = 1700000005000;
    const windowLog = new FreshnessAttentionEventLog(redis, () => now);
    await windowLog.initializeWindowedReplayCoverage(1700000000000);
    await windowLog.append(
      {
        ...baseEvent,
        kind: 'held_decision',
        toolName: 'post_message',
        unseenCount: 1,
        reason: 'unseen_available',
        timestamp: 1700000001000,
      },
      { ownerUserId: 'owner-1' },
    );
    await windowLog.append(
      {
        ...baseEvent,
        invocationId: 'inv-owner-2',
        kind: 'forward_decision',
        toolName: 'post_message',
        reason: 'no_unseen',
        timestamp: 1700000002000,
      },
      { ownerUserId: 'owner-2' },
    );

    const complete = await windowLog.queryWindowBetween(1700000000000, settledWindowEnd, 'owner-1');
    assert.equal(complete.coverage.status, 'complete');
    assert.deepEqual(
      complete.events.map((event) => event.kind),
      ['held_decision'],
    );

    const beforeCoverage = await windowLog.queryWindowBetween(1699999999999, settledWindowEnd, 'owner-1');
    assert.equal(beforeCoverage.coverage.status, 'incomplete');
    assert.equal(beforeCoverage.coverage.reason, 'window_starts_before_coverage');

    const unsettledTail = await windowLog.queryWindowBetween(1700000000000, settledWindowEnd + 1, 'owner-1');
    assert.equal(unsettledTail.coverage.status, 'incomplete');
    assert.equal(unsettledTail.coverage.reason, 'window_ends_after_observed_through');

    const restartedAt = 1700000003000;
    assert.equal(await windowLog.initializeWindowedReplayCoverage(restartedAt), restartedAt);
    const spanningRestart = await windowLog.queryWindowBetween(1700000000000, settledWindowEnd, 'owner-1');
    assert.equal(spanningRestart.coverage.status, 'incomplete');
    assert.equal(spanningRestart.coverage.reason, 'window_starts_before_coverage');
  });

  it('invalidates later publication when a fail-open event append leaves a process-local gap', async () => {
    const transaction = {
      rpush() {
        return transaction;
      },
      expire() {
        return transaction;
      },
      zadd() {
        return transaction;
      },
      zremrangebyscore() {
        return transaction;
      },
      async exec() {
        throw new Error('simulated append failure');
      },
    };
    const gapLog = new FreshnessAttentionEventLog(
      {
        multi: () => transaction,
        get: async () => '0',
        zrangebyscore: async () => [],
      },
      () => 100_000,
    );
    await assert.rejects(
      gapLog.append(
        {
          ...baseEvent,
          kind: 'forward_decision',
          toolName: 'post_message',
          reason: 'no_unseen',
          timestamp: 100_000,
        },
        { ownerUserId: 'owner-1' },
      ),
      /simulated append failure/,
    );

    const result = await gapLog.queryWindowBetween(0, 10_000, 'owner-1');
    assert.equal(result.coverage.status, 'incomplete');
    assert.equal(result.coverage.reason, 'event_append_gap');
    assert.equal(result.coverage.completeFromMs, 100_001);
  });

  it('invalidates later publication when startup cannot advance the durable coverage fence', async () => {
    let now = 200_000;
    const gapLog = new FreshnessAttentionEventLog(
      {
        eval: async () => {
          throw new Error('simulated startup Redis outage');
        },
        get: async () => '0',
        zrangebyscore: async () => [],
      },
      () => now,
    );
    await assert.rejects(gapLog.initializeWindowedReplayCoverage(), /simulated startup Redis outage/);

    now = 300_000;
    const result = await gapLog.queryWindowBetween(0, 100_000, 'owner-1');
    assert.equal(result.coverage.status, 'incomplete');
    assert.equal(result.coverage.reason, 'event_append_gap');
    assert.equal(result.coverage.completeFromMs, 200_001);
  });

  it('fails owner-scoped replay closed when an event lacks owner provenance', async () => {
    const now = 1700000065000;
    const settledWindowEnd = 1700000005000;
    const windowLog = new FreshnessAttentionEventLog(redis, () => now);
    await windowLog.initializeWindowedReplayCoverage(1700000000000);
    await windowLog.append({
      ...baseEvent,
      kind: 'forward_decision',
      toolName: 'post_message',
      reason: 'no_unseen',
      timestamp: 1700000001000,
    });

    const result = await windowLog.queryWindowBetween(1700000000000, settledWindowEnd, 'owner-1');
    assert.equal(result.coverage.status, 'incomplete');
    assert.equal(result.coverage.reason, 'unscoped_events_present');
    assert.deepEqual(result.events, []);

    const unrelatedThread = await windowLog.queryWindowBetween(1700000000000, settledWindowEnd, 'owner-1', {
      threadIds: ['thread-without-unscoped-event'],
    });
    assert.equal(unrelatedThread.coverage.status, 'complete');
    assert.deepEqual(unrelatedThread.events, []);
  });

  // --- held_decision event ---

  it('records held_decision events from Phase A gate', async () => {
    await log.append({
      ...baseEvent,
      kind: 'held_decision',
      toolName: 'post_message',
      unseenCount: 2,
      reason: 'unseen_available',
    });

    const results = await log.queryByInvocation(baseEvent.invocationId);
    assert.equal(results.length, 1);
    assert.equal(results[0].kind, 'held_decision');
    assert.equal(results[0].unseenCount, 2);
  });

  // --- unresolved notice projection ---

  it('getUnresolvedNotices returns notices without matching acks', async () => {
    // Deliver two notices
    await log.append({
      ...baseEvent,
      kind: 'notice_attached',
      toolName: 'search_evidence',
      unseenSenders: ['user'],
      noticeId: 'notice-001',
      maxMessageId: '0000000000000010-000001-aaaaaaaa',
      timestamp: 1700000000000,
    });
    await log.append({
      ...baseEvent,
      kind: 'notice_attached',
      toolName: 'list_tasks',
      unseenSenders: ['user'],
      noticeId: 'notice-002',
      maxMessageId: '0000000000000015-000001-bbbbbbbb',
      timestamp: 1700000001000,
    });

    // Ack only the first
    await log.append({
      ...baseEvent,
      kind: 'notice_implicit_acked',
      noticeIds: ['notice-001'],
      ackedVia: 'seenCursor_advance',
      timestamp: 1700000002000,
    });

    const unresolved = await log.getUnresolvedNotices(baseEvent.invocationId);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].noticeId, 'notice-002');
  });

  it('getUnresolvedNotices returns empty when all notices acked', async () => {
    await log.append({
      ...baseEvent,
      kind: 'notice_attached',
      toolName: 'search_evidence',
      unseenSenders: ['user'],
      noticeId: 'notice-001',
      maxMessageId: '0000000000000010-000001-aaaaaaaa',
    });

    await log.append({
      ...baseEvent,
      kind: 'notice_implicit_acked',
      noticeIds: ['notice-001'],
      ackedVia: 'seenCursor_advance',
    });

    const unresolved = await log.getUnresolvedNotices(baseEvent.invocationId);
    assert.equal(unresolved.length, 0);
  });

  // --- notice_deferred ---

  it('records notice_deferred when cat exits without reading', async () => {
    await log.append({
      ...baseEvent,
      kind: 'notice_attached',
      toolName: 'search_evidence',
      unseenSenders: ['user'],
      noticeId: 'notice-001',
      maxMessageId: '0000000000000010-000001-aaaaaaaa',
    });

    await log.append({
      ...baseEvent,
      kind: 'notice_deferred',
      noticeIds: ['notice-001'],
    });

    const results = await log.queryByInvocation(baseEvent.invocationId);
    assert.equal(results.length, 2);
    assert.equal(results[1].kind, 'notice_deferred');
  });

  // --- reinvoke events ---

  it('records reinvoke_triggered and reinvoke_skipped events', async () => {
    await log.append({
      ...baseEvent,
      kind: 'reinvoke_triggered',
      triggeredInvocationId: 'inv-002',
      sourceNoticeIds: ['notice-001'],
    });

    await log.append({
      ...baseEvent,
      invocationId: 'inv-003',
      kind: 'reinvoke_skipped',
      reason: 'cursor_caught_up',
    });

    const inv1 = await log.queryByInvocation('inv-001');
    assert.equal(inv1.length, 1);
    assert.equal(inv1[0].kind, 'reinvoke_triggered');

    const inv3 = await log.queryByInvocation('inv-003');
    assert.equal(inv3.length, 1);
    assert.equal(inv3[0].kind, 'reinvoke_skipped');
    assert.equal(inv3[0].reason, 'cursor_caught_up');
  });

  // --- TTL ---

  it('events have TTL for automatic cleanup (not permanent like ball custody)', async () => {
    await log.append({
      ...baseEvent,
      kind: 'forward_decision',
      toolName: 'post_message',
      reason: 'no_unseen',
    });

    // ioredis: ttl() auto-prepends keyPrefix, keys() does NOT (redis-pitfalls.md)
    // So use ttl() directly with the logical key name
    const ttl = await redis.ttl('freshness:events:inv:inv-001');
    // TTL should be > 0 (set) and reasonable (7 days = 604800s)
    assert.ok(ttl > 0, `Expected TTL > 0 but got ${ttl}`);
    assert.ok(ttl <= 604800, `Expected TTL <= 604800 but got ${ttl}`);
  });
});
