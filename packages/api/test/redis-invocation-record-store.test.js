/**
 * RedisInvocationRecordStore tests
 * 有 Redis → 测全量；无 Redis → skip
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisInvocationRecordStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisInvocationRecordStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisInvocationRecordStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js');
    RedisInvocationRecordStore = storeModule.RedisInvocationRecordStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-invocation-record-store.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisInvocationRecordStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['invoc:*', 'invoc-terminal:*', 'idemp:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['invoc:*', 'invoc-terminal:*', 'idemp:*']);
  });

  it('rejects an unclassified action-lease carrier before writing Redis state', async () => {
    await assert.rejects(
      () =>
        store.create({
          threadId: 'thread-unclassified',
          userId: 'user-1',
          targetCats: ['opus'],
          intent: 'execute',
          idempotencyKey: 'missing-carrier',
        }),
      /explicit action lease carrier classification/,
    );
  });

  it('create() returns created outcome', async () => {
    const result = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'redis-key-1',
      actionLeaseCarrier: { kind: 'none' },
    });

    assert.equal(result.outcome, 'created');
    assert.ok(result.invocationId.length > 0);
  });

  it('create() record has correct initial state', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus', 'codex'],
      intent: 'ideate',
      idempotencyKey: 'redis-key-2',
      actionLeaseCarrier: { kind: 'none' },
    });

    const record = await store.get(invocationId);
    assert.ok(record);
    assert.equal(record.status, 'queued');
    assert.equal(record.userMessageId, null);
    assert.equal(record.threadId, 'thread-1');
    assert.equal(record.userId, 'user-1');
    assert.deepEqual(record.targetCats, ['opus', 'codex']);
    assert.equal(record.intent, 'ideate');
    assert.equal(record.idempotencyKey, 'redis-key-2');
    assert.equal(record.error, undefined);
  });

  it('create() persists ordinary and action-successor carrier classifications', async () => {
    const { invocationId: ordinaryInvocationId } = await store.create({
      threadId: 'thread-review',
      userId: 'user-review',
      targetCats: ['codex-sol'],
      intent: 'execute',
      idempotencyKey: 'redis-review-no-action-lease',
      actionLeaseCarrier: { kind: 'none' },
    });
    const { invocationId } = await store.create({
      threadId: 'thread-review',
      userId: 'user-review',
      targetCats: ['codex-sol'],
      intent: 'execute',
      idempotencyKey: 'redis-review-action-lease',
      actionLeaseCarrier: {
        kind: 'action_successor',
        leaseId: 'lease-review-1',
        generation: 2,
      },
    });

    assert.deepEqual((await store.get(ordinaryInvocationId)).actionLeaseCarrier, { kind: 'none' });
    assert.deepEqual((await store.get(invocationId)).actionLeaseCarrier, {
      kind: 'action_successor',
      leaseId: 'lease-review-1',
      generation: 2,
    });
  });

  it('persists an exact wait continuation carrier without promoting its owner fence', async () => {
    const waitContinuationCarrier = {
      v: 1,
      waitId: 'task-pr-7',
      outcomeId: 'wait:pr:owner/repo#7:g4:matched',
      ownerFence: { kind: 'action_successor', leaseId: 'lease-wait-4', generation: 4 },
    };
    const { invocationId } = await store.create({
      threadId: 'thread-wait',
      userId: 'user-wait',
      targetCats: ['codex-sol'],
      intent: 'execute',
      idempotencyKey: 'redis-wait-carrier',
      actionLeaseCarrier: { kind: 'none' },
      waitContinuationCarrier,
    });

    const record = await store.get(invocationId);
    assert.deepEqual(record.waitContinuationCarrier, waitContinuationCarrier);
    assert.deepEqual(record.actionLeaseCarrier, { kind: 'none' });
  });

  it('rejects malformed wait continuation carriers before writing Redis state', async () => {
    await assert.rejects(
      () =>
        store.create({
          threadId: 'thread-wait-invalid',
          userId: 'user-wait',
          targetCats: ['codex-sol'],
          intent: 'execute',
          idempotencyKey: 'redis-wait-carrier-invalid',
          actionLeaseCarrier: { kind: 'none' },
          waitContinuationCarrier: {
            v: 1,
            waitId: 'task-pr-7',
            outcomeId: 'wait:pr:owner/repo#7:g0:matched',
            ownerFence: { kind: 'containing_task', generation: 0 },
          },
        }),
      /invalid wait continuation carrier/,
    );
    assert.equal(await redis.exists('idemp:thread-wait-invalid:user-wait:redis-wait-carrier-invalid'), 0);
  });

  it('fails closed when a persisted wait continuation carrier is malformed', async () => {
    const now = String(Date.now());
    await redis.hset('invoc:malformed-wait-carrier', {
      id: 'malformed-wait-carrier',
      threadId: 'thread-wait',
      userId: 'user-wait',
      targetCats: JSON.stringify(['codex-sol']),
      intent: 'execute',
      idempotencyKey: 'malformed-wait-carrier',
      status: 'running',
      userMessageId: '',
      error: '',
      actionLeaseCarrier: JSON.stringify({ kind: 'none' }),
      waitContinuationCarrier: JSON.stringify({ v: 1, waitId: 'task-pr-7' }),
      createdAt: now,
      updatedAt: now,
    });

    await assert.rejects(() => store.get('malformed-wait-carrier'), /invalid wait continuation carrier/);
  });

  it('hydrates the pre-classifier actionLeaseRef field as an action-successor carrier', async () => {
    const now = String(Date.now());
    await redis.hset('invoc:legacy-action-carrier', {
      id: 'legacy-action-carrier',
      threadId: 'thread-review',
      userId: 'user-review',
      targetCats: JSON.stringify(['codex-sol']),
      intent: 'execute',
      idempotencyKey: 'legacy-action-carrier',
      status: 'running',
      userMessageId: '',
      error: '',
      actionLeaseRef: JSON.stringify({ leaseId: 'lease-legacy', generation: 4 }),
      createdAt: now,
      updatedAt: now,
    });

    assert.deepEqual((await store.get('legacy-action-carrier')).actionLeaseCarrier, {
      kind: 'action_successor',
      leaseId: 'lease-legacy',
      generation: 4,
    });
  });

  it('Lua atomic dedup returns duplicate on same key', async () => {
    const first = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'dup-key',
      actionLeaseCarrier: { kind: 'none' },
    });
    assert.equal(first.outcome, 'created');

    const second = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'dup-key',
      actionLeaseCarrier: { kind: 'none' },
    });
    assert.equal(second.outcome, 'duplicate');
    assert.equal(second.invocationId, first.invocationId);
  });

  it('different threadId with same key does not dedup', async () => {
    const first = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'same-key',
      actionLeaseCarrier: { kind: 'none' },
    });
    const second = await store.create({
      threadId: 'thread-2',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'same-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    assert.equal(first.outcome, 'created');
    assert.equal(second.outcome, 'created');
    assert.notEqual(first.invocationId, second.invocationId);
  });

  it('get() returns null for non-existent id', async () => {
    const result = await store.get('non-existent-id');
    assert.equal(result, null);
  });

  it('update() changes status', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'upd-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    const updated = await store.update(invocationId, { status: 'running' });
    assert.equal(updated.status, 'running');
  });

  it('update() backfills userMessageId', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'backfill-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    const before = await store.get(invocationId);
    assert.equal(before.userMessageId, null);

    await store.update(invocationId, { userMessageId: 'msg-456' });
    const after = await store.get(invocationId);
    assert.equal(after.userMessageId, 'msg-456');
  });

  it('F254 Phase E persists typed closure custody fields', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-f254',
      userId: 'user-f254',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'f254-custody',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(invocationId, {
      freshnessClosureId: 'closure-1',
      freshnessInputFrontierMessageId: 'msg-frontier',
      freshnessClosureStatus: 'running',
    });

    const record = await store.get(invocationId);
    assert.equal(record.freshnessClosureId, 'closure-1');
    assert.equal(record.freshnessInputFrontierMessageId, 'msg-frontier');
    assert.equal(record.freshnessClosureStatus, 'running');
  });

  it('persists and hydrates a durable connector execution-start receipt', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-connector-start',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'connector-start-receipt',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(invocationId, { status: 'running', expectedStatus: 'queued' });

    const updated = await store.update(invocationId, {
      executionStartedAt: 1_700_000_000_000,
      expectedStatus: 'running',
    });
    const hydrated = await store.get(invocationId);

    assert.equal(updated.executionStartedAt, 1_700_000_000_000);
    assert.equal(hydrated.executionStartedAt, 1_700_000_000_000);
  });

  it('atomically clears the previous execution-start receipt when a failed record starts a new attempt', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-connector-retry',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'connector-retry-receipt',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(invocationId, { status: 'running', expectedStatus: 'queued' });
    await store.update(invocationId, {
      executionStartedAt: 1_700_000_000_000,
      expectedStatus: 'running',
    });
    await store.update(invocationId, {
      status: 'failed',
      error: 'process_restart',
      expectedStatus: 'running',
    });

    const retried = await store.update(invocationId, {
      status: 'running',
      error: '',
      expectedStatus: 'failed',
    });
    const hydrated = await store.get(invocationId);

    assert.equal(retried.executionStartedAt, undefined);
    assert.equal(hydrated.executionStartedAt, undefined);
  });

  it('update() sets error on failed status', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'err-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    await store.update(invocationId, { status: 'running' });
    await store.update(invocationId, { status: 'failed', error: 'CLI ENOENT' });
    const record = await store.get(invocationId);
    assert.equal(record.status, 'failed');
    assert.equal(record.error, 'CLI ENOENT');
  });

  it('update() returns null for non-existent id', async () => {
    const result = await store.update('non-existent', { status: 'running' });
    assert.equal(result, null);
  });

  it('getByIdempotencyKey() finds record', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'lookup-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    const found = await store.getByIdempotencyKey('thread-1', 'user-1', 'lookup-key');
    assert.ok(found);
    assert.equal(found.id, invocationId);
  });

  it('CAS update() succeeds when expectedStatus matches', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'cas-ok-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    const result = await store.update(invocationId, {
      status: 'running',
      expectedStatus: 'queued',
    });
    assert.ok(result);
    assert.equal(result.status, 'running');
  });

  it('CAS update() returns null when expectedStatus mismatches', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'cas-fail-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    const result = await store.update(invocationId, {
      status: 'running',
      expectedStatus: 'failed', // actual is 'queued'
    });
    assert.equal(result, null);

    // Status unchanged
    const record = await store.get(invocationId);
    assert.equal(record.status, 'queued');
  });

  it('expectedUsageByCatAbsent rejects populated usageByCat atomically', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'usage-absent-guard-key',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(invocationId, { status: 'running' });
    await store.update(invocationId, {
      status: 'succeeded',
      usageByCat: { opus: { inputTokens: 10, outputTokens: 1 } },
      usageRecordedAt: 1_700_000_000_000,
    });

    const result = await store.update(invocationId, {
      usageByCat: { codex: { inputTokens: 20, outputTokens: 2 } },
      usageRecordedAt: 1_700_000_001_000,
      expectedStatus: 'succeeded',
      expectedUsageByCatAbsent: true,
    });

    assert.equal(result, null);
    const record = await store.get(invocationId);
    assert.deepEqual(record.usageByCat, { opus: { inputTokens: 10, outputTokens: 1 } });
    assert.equal(record.usageRecordedAt, 1_700_000_000_000);
  });

  it('persists exact successful targets for a shared invocation', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-f254-shared',
      userId: 'user-f254',
      targetCats: ['opus', 'codex'],
      intent: 'execute',
      idempotencyKey: 'f254-shared-success',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(invocationId, { status: 'running' });
    await assert.rejects(
      store.update(invocationId, {
        status: 'succeeded',
        successfulCatIds: ['gemini'],
      }),
      /successfulCatIds.*targetCats/i,
      'invalid input must be distinguishable from a CAS rejection',
    );
    assert.equal((await store.get(invocationId)).status, 'running');
    await assert.rejects(
      store.update(invocationId, { status: 'succeeded', successfulCatIds: [] }),
      /successfulCatIds.*non-empty/i,
    );

    await store.update(invocationId, {
      status: 'succeeded',
      successfulCatIds: ['opus'],
    });

    const record = await store.get(invocationId);
    assert.deepEqual(record.successfulCatIds, ['opus']);

    await assert.rejects(
      store.update(invocationId, { successfulCatIds: ['codex'] }),
      /successfulCatIds.*succeeded/i,
      'the terminal witness is immutable outside the succeeded transition',
    );
  });

  it('F297 records the latest terminal lifecycle witness per thread and user', async () => {
    const succeeded = await store.create({
      threadId: 'thread-terminal-pointer',
      userId: 'user-terminal',
      targetCats: ['opus', 'codex'],
      intent: 'execute',
      idempotencyKey: 'terminal-pointer-success',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(succeeded.invocationId, { status: 'running' });
    await store.update(succeeded.invocationId, {
      status: 'succeeded',
      successfulCatIds: ['opus'],
    });

    const terminal = await store.listLatestTerminalByThreadIds(
      ['thread-terminal-pointer', 'thread-unrelated'],
      'user-terminal',
    );
    assert.equal(terminal.size, 1);
    assert.equal(terminal.get('thread-terminal-pointer').id, succeeded.invocationId);
    assert.equal(terminal.get('thread-terminal-pointer').status, 'succeeded');
    assert.deepEqual(terminal.get('thread-terminal-pointer').successfulCatIds, ['opus']);
    assert.equal(
      (await store.listLatestTerminalByThreadIds(['thread-terminal-pointer'], 'other-user')).size,
      0,
      'terminal presentation is owner-scoped',
    );
  });

  it('F297 newer terminal transitions supersede older ones and retry clears its failure', async () => {
    const oldSuccess = await store.create({
      threadId: 'thread-terminal-latest',
      userId: 'user-terminal',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'terminal-old-success',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(oldSuccess.invocationId, { status: 'running' });
    await store.update(oldSuccess.invocationId, { status: 'succeeded', successfulCatIds: ['opus'] });

    const retrying = await store.create({
      threadId: 'thread-terminal-latest',
      userId: 'user-terminal',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: 'terminal-new-failure',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(retrying.invocationId, { status: 'running' });
    await store.update(retrying.invocationId, { status: 'failed', error: 'transient' });

    let terminal = await store.listLatestTerminalByThreadIds(['thread-terminal-latest'], 'user-terminal');
    assert.equal(terminal.get('thread-terminal-latest').id, retrying.invocationId);
    assert.equal(terminal.get('thread-terminal-latest').status, 'failed');

    await store.update(retrying.invocationId, { status: 'running', expectedStatus: 'failed' });
    terminal = await store.listLatestTerminalByThreadIds(['thread-terminal-latest'], 'user-terminal');
    assert.equal(terminal.size, 0, 'retrying must clear the visible failure instead of resurrecting an older success');

    await store.update(retrying.invocationId, { status: 'canceled', expectedStatus: 'running' });
    terminal = await store.listLatestTerminalByThreadIds(['thread-terminal-latest'], 'user-terminal');
    assert.equal(terminal.get('thread-terminal-latest').status, 'canceled');
  });

  it('concurrent CAS update: only one wins (Lua atomic)', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'cas-race-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    // Transition through proper lifecycle: queued → running → failed (retry starts from failed)
    await store.update(invocationId, { status: 'running' });
    await store.update(invocationId, { status: 'failed', error: 'boom' });

    // Fire N concurrent CAS transitions: failed → running
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        store.update(invocationId, {
          status: 'running',
          error: '',
          expectedStatus: 'failed',
        }),
      ),
    );

    const winners = results.filter((r) => r !== null);
    const losers = results.filter((r) => r === null);
    assert.equal(winners.length, 1, `Expected exactly 1 winner, got ${winners.length}`);
    assert.equal(losers.length, N - 1);
    assert.equal(winners[0].status, 'running');
  });

  it('non-CAS update rejects illegal transition atomically', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'guard-no-cas',
      actionLeaseCarrier: { kind: 'none' },
    });

    // queued → running → succeeded (terminal)
    await store.update(invocationId, { status: 'running' });
    await store.update(invocationId, { status: 'succeeded' });

    // succeeded → failed is illegal, must be rejected
    const result = await store.update(invocationId, { status: 'failed', error: 'should not happen' });
    assert.equal(result, null);

    const record = await store.get(invocationId);
    assert.equal(record.status, 'succeeded');
    assert.equal(record.error, undefined);
  });

  it('same-status update on terminal state is rejected (cloud P1)', async () => {
    // Reproduces cloud Codex P1: succeeded→succeeded bypassed state machine
    // because Lua only checked transitions when newStatus ~= current.
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'self-transition',
      actionLeaseCarrier: { kind: 'none' },
    });

    await store.update(invocationId, { status: 'running' });
    await store.update(invocationId, { status: 'succeeded' });

    // succeeded → succeeded should be rejected (terminal, no self-transitions)
    const result = await store.update(invocationId, { status: 'succeeded', error: 'late error' });
    assert.equal(result, null);

    const record = await store.get(invocationId);
    assert.equal(record.status, 'succeeded');
    assert.equal(record.error, undefined);
  });

  it('concurrent non-CAS updates cannot regress terminal state (race regression)', async () => {
    // Reproduces the P1 bug: concurrent non-CAS writes could bypass state machine.
    // Before fix: hget(status) → validate → hset was non-atomic, allowing
    // a stale read to overwrite a newer terminal status.
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'race-no-cas',
      actionLeaseCarrier: { kind: 'none' },
    });

    // Get to running state
    await store.update(invocationId, { status: 'running' });

    // Fire concurrent: one tries succeeded, another tries failed
    // Both are legal from running, but only one should win.
    // The loser's transition should be rejected (not silently applied).
    const [r1, r2] = await Promise.all([
      store.update(invocationId, { status: 'succeeded' }),
      store.update(invocationId, { status: 'failed', error: 'late failure' }),
    ]);

    const record = await store.get(invocationId);

    if (r1 !== null) {
      // succeeded won — failed must have been rejected (succeeded is terminal)
      assert.equal(record.status, 'succeeded');
      assert.equal(record.error, undefined);
    } else {
      // failed won — succeeded must have been rejected (failed is not terminal, but
      // the point is: final state must be consistent with one atomic transition)
      assert.equal(record.status, 'failed');
      assert.ok(r2 !== null);
    }

    // Key invariant: exactly one winner
    const winners = [r1, r2].filter((r) => r !== null);
    assert.equal(winners.length, 1, 'Exactly one concurrent update should succeed');
  });

  it('getByIdempotencyKey() returns null for wrong scope', async () => {
    await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'scoped-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    const r1 = await store.getByIdempotencyKey('thread-2', 'user-1', 'scoped-key');
    assert.equal(r1, null);
    const r2 = await store.getByIdempotencyKey('thread-1', 'user-2', 'scoped-key');
    assert.equal(r2, null);
  });

  it('F194 Phase B — listRunningByThread is index-backed (SMEMBERS, not SCAN)', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    // Create + transition to running
    const r1 = await store.create({
      threadId: 'thread-A',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'list-r1',
      actionLeaseCarrier: { kind: 'none' },
    });
    const r2 = await store.create({
      threadId: 'thread-A',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'list-r2',
      actionLeaseCarrier: { kind: 'none' },
    });
    const r3 = await store.create({
      threadId: 'thread-A',
      userId: 'user-2', // different user
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'list-r3',
      actionLeaseCarrier: { kind: 'none' },
    });

    await store.update(r1.invocationId, { status: 'running' });
    await store.update(r2.invocationId, { status: 'running' });
    await store.update(r2.invocationId, { status: 'succeeded' }); // exits running
    await store.update(r3.invocationId, { status: 'running' });

    const running = await store.listRunningByThread('thread-A', 'user-1');
    const ids = running.map((r) => r.id).sort();
    assert.deepEqual(ids, [r1.invocationId].sort(), 'only r1 (running + thread-A + user-1) returned');

    // Verify index actually used: the running set should contain just r1's id under user-1
    const setKey = `cat-cafe:invoc:running:thread-A:user-1`; // matches keyPrefix + InvocationKeys.runningByThread
    const setMembers = await redis.smembers('invoc:running:thread-A:user-1'); // ioredis auto-prefix
    assert.deepEqual(setMembers.sort(), [r1.invocationId].sort(), 'index Set tracks only running r1');
    void setKey;
  });

  it('F194 Phase B — defensive filter cleans stale Set members', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const r = await store.create({
      threadId: 'thread-X',
      userId: 'user-Y',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'stale-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    // Inject stale member directly into the index (simulate update→Set race or external corruption)
    await redis.sadd('invoc:running:thread-X:user-Y', 'fake-stale-id');
    // Real record is queued, not running
    const setBefore = await redis.smembers('invoc:running:thread-X:user-Y');
    assert.ok(setBefore.includes('fake-stale-id'));

    // listRunningByThread filters defensively + cleans up
    const running = await store.listRunningByThread('thread-X', 'user-Y');
    assert.equal(running.length, 0, 'queued record + fake stale id both filtered');

    // Allow the fire-and-forget SREM to complete
    await new Promise((resolve) => setTimeout(resolve, 50));
    const setAfter = await redis.smembers('invoc:running:thread-X:user-Y');
    assert.equal(setAfter.includes('fake-stale-id'), false, 'stale id was cleaned up');
    void r;
  });

  it('F194 Phase B (cloud R13 P1) — backfill running index for pre-deploy records', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    // Reproduces cloud Codex P1: pre-deploy `running` records aren't in the
    // `invoc:running:{tid}:{uid}` Set because the Set is only populated on
    // future status transitions in update(). Without backfill, a fresh deploy's
    // listRunningByThread returns [] for these orphaned records.
    //
    // Simulate by writing a record directly via HSET (bypasses create+update),
    // verify the Set is empty, then assert listRunningByThread surfaces it
    // anyway (lazy backfill path).

    // Inject a "pre-deploy" running record straight into Redis (no SADD)
    const preDeployId = 'pre-deploy-running-1';
    await redis.hset(`invoc:${preDeployId}`, {
      id: preDeployId,
      threadId: 'thread-PD',
      userId: 'user-PD',
      targetCats: '["opus"]',
      intent: 'execute',
      idempotencyKey: 'pre-deploy-key',
      status: 'running',
      userMessageId: '',
      error: '',
      createdAt: String(Date.now() - 10_000),
      updatedAt: String(Date.now() - 10_000),
    });

    // Sanity: Set is empty (no SADD was triggered for this record)
    const setBefore = await redis.smembers('invoc:running:thread-PD:user-PD');
    assert.equal(setBefore.length, 0, 'pre-deploy record absent from Set');

    // ⚠️ Use a fresh store instance so the per-process backfill flag isn't already set
    const freshStore = new RedisInvocationRecordStore(redis);
    const running = await freshStore.listRunningByThread('thread-PD', 'user-PD');
    const ids = running.map((r) => r.id);
    assert.deepEqual(ids, [preDeployId], 'pre-deploy running record surfaced via backfill');

    // Set is now populated (backfill side-effect)
    const setAfter = await redis.smembers('invoc:running:thread-PD:user-PD');
    assert.deepEqual(setAfter.sort(), [preDeployId].sort(), 'index populated after backfill');
  });

  it('F194 Phase B (cloud R13 P1) — backfill is one-time per process', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    // Once backfilled, a second listRunningByThread on a different (tid,uid) must
    // NOT re-scan: behavior is observable by injecting a record post-backfill,
    // skipping update(), and asserting it does NOT surface (because no SADD).
    const freshStore = new RedisInvocationRecordStore(redis);

    // First call triggers backfill (Set empty + no records → trivial backfill)
    await freshStore.listRunningByThread('thread-Z', 'user-Z');

    // Inject a post-backfill orphan; backfill should NOT re-run
    const orphanId = 'post-backfill-orphan-1';
    await redis.hset(`invoc:${orphanId}`, {
      id: orphanId,
      threadId: 'thread-Z',
      userId: 'user-Z',
      targetCats: '["opus"]',
      intent: 'execute',
      idempotencyKey: 'orphan-key',
      status: 'running',
      userMessageId: '',
      error: '',
      createdAt: String(Date.now()),
      updatedAt: String(Date.now()),
    });

    const running = await freshStore.listRunningByThread('thread-Z', 'user-Z');
    assert.equal(running.length, 0, 'orphan injected after backfill is NOT resurrected');
  });

  it('F194 Phase B (cloud R16 P2) — backfill skips invoc:running:* set keys (no wasted HGETALL)', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    // Reproduces cloud Codex P2 (comment 3211824356, line 395): SCAN MATCH=invoc:*
    // matches both record hashes (invoc:{uuid}) and running-set keys
    // (invoc:running:{tid}:{uid}). Without filtering, backfill HGETALLs the set keys
    // too — wasted round trips on first read. Verify backfill ONLY pipelines HGETALL
    // for record hashes by counting hgetall pipeline calls under controlled state.

    // Setup: mix of record hashes + running-set keys
    const recordId = 'r16-record-1';
    await redis.hset(`invoc:${recordId}`, {
      id: recordId,
      threadId: 'r16-T',
      userId: 'r16-U',
      targetCats: '["opus"]',
      intent: 'execute',
      idempotencyKey: 'r16-key',
      status: 'running',
      userMessageId: '',
      error: '',
      createdAt: String(Date.now()),
      updatedAt: String(Date.now()),
    });
    // Pre-existing running-set key (matches SCAN MATCH=invoc:*)
    await redis.sadd('invoc:running:other-T:other-U', 'placeholder-id');

    // Wrap redis.pipeline to count hgetall calls
    const origPipeline = redis.pipeline.bind(redis);
    const hgetallTargetKeys = [];
    redis.pipeline = (...args) => {
      const p = origPipeline(...args);
      const origHgetall = p.hgetall.bind(p);
      p.hgetall = (key) => {
        hgetallTargetKeys.push(key);
        return origHgetall(key);
      };
      return p;
    };

    try {
      const freshStore = new RedisInvocationRecordStore(redis);
      const running = await freshStore.listRunningByThread('r16-T', 'r16-U');
      assert.deepEqual(
        running.map((r) => r.id),
        [recordId],
        'pre-deploy record surfaced via backfill',
      );
    } finally {
      redis.pipeline = origPipeline;
    }

    // Critical assertion: backfill HGETALL must NOT have targeted any invoc:running:* key
    const setKeyHgetalls = hgetallTargetKeys.filter((k) => k.startsWith('invoc:running:'));
    assert.equal(
      setKeyHgetalls.length,
      0,
      `backfill must not HGETALL running-set keys (saw: ${JSON.stringify(setKeyHgetalls)})`,
    );
    // And it should have HGETALL'd at least the record hash
    const recordHgetalls = hgetallTargetKeys.filter((k) => k === `invoc:${recordId}`);
    assert.ok(recordHgetalls.length > 0, 'backfill must HGETALL the record hash');
  });

  it('F194 Phase B (cloud R13 P1 #2) — update() converges Set membership when userId changes mid-flight', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    // Reproduces cloud Codex P1 #2 (comment 3209482070): update() derives setKey
    // from a pre-read snapshot of (threadId, userId). If reassignUserId() runs between
    // the snapshot and EVAL, the Lua applies SADD/SREM to the WRONG running set, leaving
    // a live invocation either stranded in the old set or missing from the new one.
    //
    // Test orchestrates the race by wrapping redis.eval to inject a userId change +
    // Set migration AFTER the JS-side snapshot read but BEFORE the actual EVAL fires.
    // Fix should detect (threadId, userId) drift inside Lua and retry with fresh setKey.

    // Setup: queued record under user-A
    const r = await store.create({
      threadId: 'thread-race',
      userId: 'user-A',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'race-key',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(r.invocationId, { status: 'running' });

    // Sanity: record is in user-A's running set
    const setA = await redis.smembers('invoc:running:thread-race:user-A');
    let setB = await redis.smembers('invoc:running:thread-race:user-B');
    assert.deepEqual(setA, [r.invocationId]);
    assert.equal(setB.length, 0);

    // Race injection: wrap eval so the FIRST eval call simulates reassignUserId
    // having migrated the record to user-B between get() and EVAL.
    const origEval = redis.eval.bind(redis);
    let injected = false;
    redis.eval = async (...args) => {
      if (!injected) {
        injected = true;
        // Atomic-ish reassignUserId simulation: HSET userId + migrate Set membership
        await redis.hset(`invoc:${r.invocationId}`, 'userId', 'user-B');
        await redis.srem('invoc:running:thread-race:user-A', r.invocationId);
        await redis.sadd('invoc:running:thread-race:user-B', r.invocationId);
      }
      return origEval(...args);
    };

    try {
      // Trigger the race: transition running → succeeded.
      // Without fix: setKey passed to Lua is "thread-race:user-A" (stale). Lua does
      // SREM there (no-op, already migrated) → record left in user-B's set despite
      // being succeeded. Defensive filter masks but membership is wrong.
      // With fix: Lua detects threadId/userId mismatch (returns -3), JS retries with
      // fresh setKey "thread-race:user-B" → SREM correctly applied.
      await store.update(r.invocationId, { status: 'succeeded' });
    } finally {
      redis.eval = origEval;
    }

    // Final state: record succeeded, NOT in user-B's running set
    const finalRecord = await store.get(r.invocationId);
    assert.equal(finalRecord.status, 'succeeded', 'status transitioned to succeeded');

    setB = await redis.smembers('invoc:running:thread-race:user-B');
    assert.equal(
      setB.includes(r.invocationId),
      false,
      'fix: record removed from current owner (user-B) set on terminal transition',
    );
  });

  it('F194 Phase B — reassignUserId migrates running Set membership', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const r = await store.create({
      threadId: 'thread-T',
      userId: 'user-old',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'reassign-key',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(r.invocationId, { status: 'running' });

    // Sanity: in old Set
    const oldBefore = await redis.smembers('invoc:running:thread-T:user-old');
    assert.deepEqual(oldBefore.sort(), [r.invocationId].sort());

    await store.reassignUserId(r.invocationId, 'user-new');

    const oldAfter = await redis.smembers('invoc:running:thread-T:user-old');
    const newAfter = await redis.smembers('invoc:running:thread-T:user-new');
    assert.equal(oldAfter.includes(r.invocationId), false, 'removed from old user Set');
    assert.deepEqual(newAfter.sort(), [r.invocationId].sort(), 'added to new user Set');

    // listRunningByThread reflects migration
    const oldList = await store.listRunningByThread('thread-T', 'user-old');
    const newList = await store.listRunningByThread('thread-T', 'user-new');
    assert.equal(oldList.length, 0);
    assert.equal(newList.length, 1);
  });

  it('F194 Phase B (cloud R14 P1) — reassignUserId Set migration is atomic (no SREM-only crash window)', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    // Reproduces cloud Codex P1 (comment 3211498998): old reassignUserId did
    // HSET userId → SREM oldSet → SADD newSet as 3 separate awaits. A crash
    // (process exit / Redis network glitch) between SREM and SADD would leave
    // a running record in NEITHER set — invisible to listRunningByThread for
    // either old or new owner, breaking canonical liveness.
    //
    // Test: wrap redis.eval to count Lua invocations during reassignUserId.
    // The fix folds HSET + SREM + SADD into a single Lua eval, so a single eval
    // call must atomically achieve the final state. Compare oldSet/newSet
    // BEFORE and AFTER the eval — they must transition together (no intermediate
    // state observable from a wrapper).

    const r = await store.create({
      threadId: 'thread-atomic',
      userId: 'user-A',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'atomic-key',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(r.invocationId, { status: 'running' });

    // Wrap eval to assert the atomic invariant: at the moment the migration Lua
    // runs, oldSet should still have the record (pre-state), and after eval
    // returns, oldSet should NOT have it AND newSet SHOULD have it (post-state).
    const origEval = redis.eval.bind(redis);
    let migrationEvalSeen = false;
    let observedAtomicTransition = false;
    redis.eval = async (script, ...rest) => {
      // Detect the migration eval by script content (single-purpose script
      // distinct from ATOMIC_UPDATE_LUA for status updates)
      const isMigration =
        typeof script === 'string' &&
        script.includes('SREM') &&
        script.includes('SADD') &&
        !script.includes('newStatus');
      if (isMigration && !migrationEvalSeen) {
        migrationEvalSeen = true;
        const preOld = await origEval(
          'return redis.call("SMEMBERS", KEYS[1])',
          1,
          'invoc:running:thread-atomic:user-A',
        );
        const preNew = await origEval(
          'return redis.call("SMEMBERS", KEYS[1])',
          1,
          'invoc:running:thread-atomic:user-B',
        );
        const result = await origEval(script, ...rest);
        const postOld = await origEval(
          'return redis.call("SMEMBERS", KEYS[1])',
          1,
          'invoc:running:thread-atomic:user-A',
        );
        const postNew = await origEval(
          'return redis.call("SMEMBERS", KEYS[1])',
          1,
          'invoc:running:thread-atomic:user-B',
        );
        // Atomic invariant: pre had old, not new; post has new, not old (both transitions in one eval)
        observedAtomicTransition =
          preOld.includes(r.invocationId) &&
          !preNew.includes(r.invocationId) &&
          !postOld.includes(r.invocationId) &&
          postNew.includes(r.invocationId);
        return result;
      }
      return origEval(script, ...rest);
    };

    try {
      await store.reassignUserId(r.invocationId, 'user-B');
    } finally {
      redis.eval = origEval;
    }

    assert.equal(migrationEvalSeen, true, 'reassignUserId must use a Lua eval for Set migration');
    assert.equal(
      observedAtomicTransition,
      true,
      'Set migration must complete in a single Lua eval — pre: old=[id], new=[]; post: old=[], new=[id]',
    );

    // Final sanity: state correct
    const oldFinal = await redis.smembers('invoc:running:thread-atomic:user-A');
    const newFinal = await redis.smembers('invoc:running:thread-atomic:user-B');
    assert.equal(oldFinal.includes(r.invocationId), false);
    assert.deepEqual(newFinal.sort(), [r.invocationId].sort());
  });

  it('F194 Phase B (cloud R14 P1) — reassignUserId skips Set migration when status drifted to terminal', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    // Edge case: if status transitions running → succeeded between snapshot and Lua,
    // the migration must read CURRENT status inside Lua and skip Set migration
    // (terminal records should not be in any running set).

    const r = await store.create({
      threadId: 'thread-drift',
      userId: 'user-A',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'drift-key',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(r.invocationId, { status: 'running' });

    // Wrap eval: between snapshot and migration Lua, transition record to succeeded
    // (this simulates a concurrent update() winning the race). The migration Lua
    // must then read current status='succeeded' and skip Set migration.
    const origEval = redis.eval.bind(redis);
    redis.eval = async (script, ...rest) => {
      const isMigration =
        typeof script === 'string' &&
        script.includes('SREM') &&
        script.includes('SADD') &&
        !script.includes('newStatus');
      if (isMigration) {
        // Inject status transition right before the migration Lua fires
        // (use HSET directly to bypass update()'s Lua and just change status)
        await redis.hset(`invoc:${r.invocationId}`, 'status', 'succeeded');
        // Record was in user-A's set; simulate update()'s SREM that would happen
        await redis.srem('invoc:running:thread-drift:user-A', r.invocationId);
      }
      return origEval(script, ...rest);
    };

    try {
      await store.reassignUserId(r.invocationId, 'user-B');
    } finally {
      redis.eval = origEval;
    }

    // After: record is succeeded with userId=user-B. Neither running set should have it.
    const finalRecord = await store.get(r.invocationId);
    assert.equal(finalRecord.status, 'succeeded');
    assert.equal(finalRecord.userId, 'user-B');

    const setA = await redis.smembers('invoc:running:thread-drift:user-A');
    const setB = await redis.smembers('invoc:running:thread-drift:user-B');
    assert.equal(setA.includes(r.invocationId), false, 'user-A set must not contain succeeded record');
    assert.equal(setB.includes(r.invocationId), false, 'user-B set must not contain succeeded record');
  });

  it('F297 ownership repair cannot leave a terminal badge visible to the old user', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    const record = await store.create({
      threadId: 'thread-terminal-reassign',
      userId: 'user-A',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'terminal-reassign',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(record.invocationId, { status: 'running' });
    await store.update(record.invocationId, { status: 'succeeded', successfulCatIds: ['opus'] });
    assert.equal((await store.listLatestTerminalByThreadIds(['thread-terminal-reassign'], 'user-A')).size, 1);

    await store.reassignUserId(record.invocationId, 'user-B');

    assert.equal(
      (await store.listLatestTerminalByThreadIds(['thread-terminal-reassign'], 'user-A')).size,
      0,
      'the old owner must not retain a badge for a record they no longer own',
    );
    assert.equal(
      (await store.listLatestTerminalByThreadIds(['thread-terminal-reassign'], 'user-B')).size,
      0,
      'repair does not invent terminal history for the new owner',
    );
  });

  it('F297 (cloud R7 P2) — listRunningThreadIds is bounded by active threads, not keyspace size', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    // 语境：buildSnapshot 在每次 GET /api/threads?view=sidebar 上调用本方法。
    // 旧实现用 SCAN MATCH —— Redis 的 SCAN 仍然遍历整个 keyspace，MATCH 只过滤**返回值**。
    // 于是 sidebar 挂载/重连的成本随「库里所有持久化键」增长，而不是随「在跑的 thread 数」。
    // 实测（本地无网络延迟）：dbsize 3 → 0.3ms；200k → 201ms。
    const running = await store.create({
      threadId: 'thread-active',
      userId: 'scan-user',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'f297-scan-1',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(running.invocationId, { status: 'running' });

    // 灌入与本用户无关的键，模拟 message / thread / invocation 数据积累
    const filler = redis.pipeline();
    for (let i = 0; i < 5000; i += 1) filler.set(`f297scanfill:${i}`, 'x');
    await filler.exec();

    let commandCount = 0;
    const originalScan = redis.scan.bind(redis);
    const originalSmembers = redis.smembers.bind(redis);
    redis.scan = (...args) => {
      commandCount += 1;
      return originalScan(...args);
    };
    redis.smembers = (...args) => {
      commandCount += 1;
      return originalSmembers(...args);
    };
    try {
      const threadIds = await store.listRunningThreadIds('scan-user');
      assert.deepEqual(threadIds, ['thread-active'], 'the active thread must still be found');
      // 5000 个无关键下，SCAN COUNT=100 需要 ~50+ 次往返；直接寻址只需 1 次。
      assert.ok(
        commandCount <= 2,
        `sidebar read path must be directly addressable, not a keyspace walk (commands=${commandCount})`,
      );
    } finally {
      redis.scan = originalScan;
      redis.smembers = originalSmembers;
      const cleanup = redis.pipeline();
      for (let i = 0; i < 5000; i += 1) cleanup.del(`f297scanfill:${i}`);
      await cleanup.exec();
    }
  });

  it('F297 (cloud R7 P2) — per-user thread index never under-reports a running thread', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    // 漏报 = false terminal（正在跑的行被显示成 done/error），是 F297 的核心禁忌。
    // 因此索引写入必须与 running set 在同一原子操作里，不能 fire-and-forget。
    const a = await store.create({
      threadId: 'thread-idx-a',
      userId: 'idx-user',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'f297-idx-a',
      actionLeaseCarrier: { kind: 'none' },
    });
    const b = await store.create({
      threadId: 'thread-idx-b',
      userId: 'idx-user',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'f297-idx-b',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(a.invocationId, { status: 'running' });
    await store.update(b.invocationId, { status: 'running' });

    assert.deepEqual((await store.listRunningThreadIds('idx-user')).sort(), ['thread-idx-a', 'thread-idx-b']);
    assert.deepEqual(await store.listRunningThreadIds('other-user'), [], 'user scoping is the store\u2019s job');

    // 终态后必须退出候选，否则 sidebar 会一直把它当 working
    await store.update(a.invocationId, { status: 'succeeded' });
    assert.deepEqual(await store.listRunningThreadIds('idx-user'), ['thread-idx-b']);

    await store.update(b.invocationId, { status: 'succeeded' });
    assert.deepEqual(await store.listRunningThreadIds('idx-user'), []);
  });

  it('F297 (cloud R7 P2) — backfill seeds the per-user index so pre-deploy records are not missed', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    // 漏报方向的回归：pre-deploy 的 running record 不在任何索引里。若 backfill 只 seed
    // per-thread set 而漏了 per-user 候选索引，sidebar 就完全看不到它 —— 正在跑的行被
    // 终态回落显示成 done/error（F297 核心禁忌）。
    const preDeployId = 'f297-pre-deploy-running';
    await redis.hset(`invoc:${preDeployId}`, {
      id: preDeployId,
      threadId: 'thread-F297PD',
      userId: 'user-F297PD',
      targetCats: '["opus"]',
      intent: 'execute',
      idempotencyKey: 'f297-pre-deploy-key',
      status: 'running',
      userMessageId: '',
      error: '',
      createdAt: String(Date.now() - 10_000),
      updatedAt: String(Date.now() - 10_000),
    });
    assert.equal(
      (await redis.smembers('invoc:running-threads:user-F297PD')).length,
      0,
      'precondition: pre-deploy record is in no index',
    );

    // fresh store：per-process backfill flag 未置位
    const freshStore = new RedisInvocationRecordStore(redis);
    assert.deepEqual(
      await freshStore.listRunningThreadIds('user-F297PD'),
      ['thread-F297PD'],
      'a pre-deploy running thread must reach the sidebar candidate set',
    );
  });

  it('F297 (cloud R7 P2) — the write side removes a thread from the index at terminal', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    // 直接检查索引内容，绕过读侧 SCARD 过滤 —— 否则写侧清理坏掉会被读侧兜底掩盖，
    // 索引将无界增长（每个历史 thread 永久留驻）。
    const rec = await store.create({
      threadId: 'thread-wr',
      userId: 'wr-user',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'f297-wr-1',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(rec.invocationId, { status: 'running' });
    assert.deepEqual(await redis.smembers('invoc:running-threads:wr-user'), ['thread-wr']);

    await store.update(rec.invocationId, { status: 'succeeded' });
    assert.deepEqual(
      await redis.smembers('invoc:running-threads:wr-user'),
      [],
      'terminal transition must evict the thread from the index itself, not rely on read-side filtering',
    );
  });

  it('F297 (cloud R7 P2) — the read side filters a drifted index entry', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    // 索引只是候选加速器，真相是 per-thread running set。人为制造多报（索引有、set 空），
    // 读侧必须过滤掉，否则 sidebar 会把一个早已结束的 thread 一直显示成 working。
    await redis.sadd('invoc:running-threads:drift-user', 'thread-ghost');
    assert.deepEqual(
      await store.listRunningThreadIds('drift-user'),
      [],
      'an index entry with no live running set must not be reported as active',
    );
  });

  it('F297 (local R8 P1) — a transient SCARD failure must fail closed, not delete a live candidate', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    // 本 PR 花了六轮修「把读失败当成没在跑」，结果新代码又犯同一个病：
    // pipeline entry 的 error 被 `const [, size]` 丢掉，非数字 size 归入 stale，
    // 于是 (a) 真实 running 候选当次消失、(b) fire-and-forget SREM 把瞬时读故障
    // **固化成持久漏报**、(c) 方法仍正常 resolve，调用方把 recordOk 记为 true、
    // discovery 标 complete → Sidebar 直接走终态回落 = false terminal。
    const rec = await store.create({
      threadId: 'thread-scard-live',
      userId: 'scard-user',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'f297-scard-1',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(rec.invocationId, { status: 'running' });
    assert.deepEqual(await store.listRunningThreadIds('scard-user'), ['thread-scard-live']);

    const originalPipeline = redis.pipeline.bind(redis);
    redis.pipeline = () => {
      const p = originalPipeline();
      p.exec = async () => [[new Error('transient-scard'), null]];
      return p;
    };
    try {
      await assert.rejects(
        () => store.listRunningThreadIds('scard-user'),
        /transient-scard/,
        'an owner-truth read failure must propagate so the caller can fail closed (complete=false → idle)',
      );
    } finally {
      redis.pipeline = originalPipeline;
    }

    // 关键：读故障不得被固化成持久删除
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      await redis.smembers('invoc:running-threads:scard-user'),
      ['thread-scard-live'],
      'a transient read failure must never evict a real candidate from the index',
    );
    assert.deepEqual(
      await store.listRunningThreadIds('scard-user'),
      ['thread-scard-live'],
      'and the candidate must still be there once the read recovers',
    );
  });

  it('F297 (local R8 P1) — a malformed SCARD reply is a read failure, not an empty set', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    const rec = await store.create({
      threadId: 'thread-scard-malformed',
      userId: 'malformed-user',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'f297-scard-2',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(rec.invocationId, { status: 'running' });

    const originalPipeline = redis.pipeline.bind(redis);
    redis.pipeline = () => {
      const p = originalPipeline();
      p.exec = async () => [[null, 'not-a-number']]; // 非数字 size
      return p;
    };
    try {
      await assert.rejects(
        () => store.listRunningThreadIds('malformed-user'),
        /SCARD/i,
        'a non-numeric SCARD reply is unknown truth, not "no running invocation"',
      );
    } finally {
      redis.pipeline = originalPipeline;
    }
    assert.deepEqual(
      await redis.smembers('invoc:running-threads:malformed-user'),
      ['thread-scard-malformed'],
      'index untouched',
    );
  });

  it('F297 (local R8 P1) — a genuinely empty running set is still cleaned from the index', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    // fail-closed 不能把真正的 stale 也保住，否则索引无界增长。
    // 判据是 error == null && size === 0，两个条件都要。
    await redis.sadd('invoc:running-threads:gc-user', 'thread-gone');
    assert.deepEqual(await store.listRunningThreadIds('gc-user'), []);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      await redis.smembers('invoc:running-threads:gc-user'),
      [],
      'an authoritative empty set must still be garbage-collected',
    );
  });

  it('F297 (local R8 P1) — a short/absent pipeline reply is a read failure, not an empty set', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    // pipeline 回复条数少于候选数（连接抖动 / 客户端异常）时，缺失的那条既不是
    // "空集合"也不是"在跑"——是未知。当成 stale 会删掉真候选，方向同 P1-1。
    const rec = await store.create({
      threadId: 'thread-short-reply',
      userId: 'short-user',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'f297-scard-3',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(rec.invocationId, { status: 'running' });

    const originalPipeline = redis.pipeline.bind(redis);
    redis.pipeline = () => {
      const p = originalPipeline();
      p.exec = async () => []; // 候选有 1 个，回复 0 条
      return p;
    };
    try {
      await assert.rejects(
        () => store.listRunningThreadIds('short-user'),
        /SCARD reply missing/,
        'a missing pipeline entry is unknown truth, not "no running invocation"',
      );
    } finally {
      redis.pipeline = originalPipeline;
    }
    assert.deepEqual(
      await redis.smembers('invoc:running-threads:short-user'),
      ['thread-short-reply'],
      'index untouched',
    );
  });

  it('F297 (local R10 P1) — negative table: unknown replies never become stale (and never SREM)', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    // 关键差异：本方法的「非 live」分支会 **SREM 索引**。把未知降成 stale 会把一次
    // 瞬时异常固化成持久漏报。所以未知必须抛出，且索引一根汗毛都不能动。
    const rec = await store.create({
      threadId: 'thread-neg',
      userId: 'neg-user',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'f297-neg-1',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(rec.invocationId, { status: 'running' });
    const setKey = 'invoc:running:thread-neg:neg-user';
    assert.deepEqual(await redis.smembers(setKey), [rec.invocationId]);

    const originalPipeline = redis.pipeline.bind(redis);
    const withReply = (reply) => {
      redis.pipeline = () => {
        const p = originalPipeline();
        p.exec = async () => reply;
        return p;
      };
    };

    try {
      const unknownReplies = [
        ['short reply (missing entry)', []],
        ['entry error', [[new Error('transient-read'), null]]],
        ['null payload', [[null, null]]],
        ['string payload', [[null, 'wrong-type']]],
        ['array payload', [[null, []]]],
        ['non-empty hash without id', [[null, { foo: 'bar' }]]],
      ];
      for (const [label, reply] of unknownReplies) {
        withReply(reply);
        await assert.rejects(
          () => store.listRunningByThread('thread-neg', 'neg-user'),
          (err) => err instanceof Error,
          `an unknown reply must fail closed: ${label}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(
          await redis.smembers(setKey),
          [rec.invocationId],
          `index must survive an unknown reply: ${label}`,
        );
      }
    } finally {
      redis.pipeline = originalPipeline;
    }

    // 权威 terminal 才可以清理索引
    await store.update(rec.invocationId, { status: 'succeeded' });
    assert.deepEqual(await store.listRunningByThread('thread-neg', 'neg-user'), []);
  });

  it('F297 (local R11 P1) — negative table: unknown ≠ non-live (prototype, inner types, identity, status, payload)', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    // R10 的表只锁了「缺 id」一种损坏形态。真正的判据是「能否**权威** hydrate」：
    // 非 plain object（Date）、非 string 字段、id 与索引不符、status 不在合法 union、
    // owner-truth 数组坏 JSON —— 全是未知，都不能降成 stale（stale 会连带 SREM）。
    const rec = await store.create({
      threadId: 'thread-neg2',
      userId: 'neg2-user',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'f297-neg2',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(rec.invocationId, { status: 'running' });
    const setKey = 'invoc:running:thread-neg2:neg2-user';
    const id = rec.invocationId;

    const originalPipeline = redis.pipeline.bind(redis);
    const withReply = (reply) => {
      redis.pipeline = () => {
        const p = originalPipeline();
        p.exec = async () => reply;
        return p;
      };
    };
    const base = {
      id,
      threadId: 'thread-neg2',
      userId: 'neg2-user',
      status: 'running',
      targetCats: '["opus"]',
      createdAt: '1700000000000',
      updatedAt: '1700000000000',
    };

    try {
      const unknown = [
        ['non-plain object (Date)', [[null, new Date(0)]]],
        ['non-string hash value', [[null, { ...base, status: [] }]]],
        ['id mismatch vs index', [[null, { ...base, id: 'other-id' }]]],
        ['status outside the union', [[null, { ...base, status: 'banana' }]]],
        ['malformed targetCats JSON', [[null, { ...base, targetCats: 'not-json' }]]],
        ['targetCats not an array', [[null, { ...base, targetCats: '{"a":1}' }]]],
      ];
      for (const [label, reply] of unknown) {
        withReply(reply);
        await assert.rejects(
          () => store.listRunningByThread('thread-neg2', 'neg2-user'),
          (err) => err instanceof Error,
          `unknown must fail closed, never become stale: ${label}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(await redis.smembers(setKey), [id], `index must survive: ${label}`);
      }

      // 对照：合法 terminal 才是可证明的非 live，允许清理
      withReply([[null, { ...base, status: 'succeeded' }]]);
      assert.deepEqual(await store.listRunningByThread('thread-neg2', 'neg2-user'), []);
    } finally {
      redis.pipeline = originalPipeline;
    }
  });

  it('F297 (cloud R12 P1) — a failed backfill must not mark the process as backfilled', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    // 部分失败却把进程永久标 backfilled ⇒ pre-deploy 的 running thread 被**永久**漏报。
    const preDeployId = 'f297-backfill-abort';
    await redis.hset(`invoc:${preDeployId}`, {
      id: preDeployId,
      threadId: 'thread-BFA',
      userId: 'user-BFA',
      targetCats: '["opus"]',
      intent: 'execute',
      idempotencyKey: 'f297-bfa',
      status: 'running',
      userMessageId: '',
      error: '',
      createdAt: String(Date.now() - 10_000),
      updatedAt: String(Date.now() - 10_000),
    });

    const freshStore = new RedisInvocationRecordStore(redis);
    const originalPipeline = redis.pipeline.bind(redis);
    let failNext = true;
    redis.pipeline = () => {
      const p = originalPipeline();
      if (failNext) {
        failNext = false;
        p.exec = async () => [[new Error('transient-backfill'), null]];
      }
      return p;
    };
    try {
      await assert.rejects(
        () => freshStore.listRunningThreadIds('user-BFA'),
        (err) => err instanceof Error,
        'a failed backfill must propagate, not silently half-populate',
      );
    } finally {
      redis.pipeline = originalPipeline;
    }

    // 关键：重试必须真的重跑 backfill（flag 未被置位）
    assert.deepEqual(
      await freshStore.listRunningThreadIds('user-BFA'),
      ['thread-BFA'],
      'the retry must re-run backfill and surface the pre-deploy running thread',
    );
  });

  it('F297 (self-found) — backfill must skip the per-user candidate index (SET, not hash)', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    // `invoc:running-threads:{userId}` 匹配 backfill 的 SCAN pattern `invoc:*`，但它是 SET。
    // 对它发 HGETALL 会 WRONGTYPE。旧代码把该错误静默 continue 掉，所以从没被发现；
    // fail-closed 一上线立刻暴露 —— 吞掉读错误会掩盖真实缺陷，这是活证据。
    await redis.sadd('invoc:running-threads:wrongtype-user', 'thread-WT');
    await redis.hset('invoc:wrongtype-rec', {
      id: 'wrongtype-rec',
      threadId: 'thread-WT',
      userId: 'wrongtype-user',
      targetCats: '["opus"]',
      intent: 'execute',
      idempotencyKey: 'f297-wt',
      status: 'running',
      userMessageId: '',
      error: '',
      createdAt: String(Date.now()),
      updatedAt: String(Date.now()),
    });

    const freshStore = new RedisInvocationRecordStore(redis);
    assert.deepEqual(
      await freshStore.listRunningByThread('thread-WT', 'wrongtype-user'),
      await freshStore.listRunningByThread('thread-WT', 'wrongtype-user'),
      'backfill must not throw WRONGTYPE on the candidate index',
    );
    assert.deepEqual(await freshStore.listRunningThreadIds('wrongtype-user'), ['thread-WT']);
  });

  it('F297 (local R12 P1) — listRunning: record-invalid hashes are unknown, never stale (no SREM)', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    // R11 表锁了 transport 层；R12 锁 record 层：缺 owner 字段 / 非 string 成员 / 非有限
    // 时间戳的 hash 无法权威 hydrate ⇒ 未知 ⇒ 抛出且不得 SREM。「resolved [] + SREM」
    // 会把一次数据损坏固化成持久漏报（false terminal 方向）。
    const rec = await store.create({
      threadId: 'thread-r12',
      userId: 'r12-user',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'f297-r12',
      actionLeaseCarrier: { kind: 'none' },
    });
    await store.update(rec.invocationId, { status: 'running' });
    const setKey = 'invoc:running:thread-r12:r12-user';
    const id = rec.invocationId;
    const base = {
      id,
      threadId: 'thread-r12',
      userId: 'r12-user',
      status: 'running',
      targetCats: '["opus"]',
      createdAt: '1700000000000',
      updatedAt: '1700000000000',
    };

    const originalPipeline = redis.pipeline.bind(redis);
    const withReply = (reply) => {
      redis.pipeline = () => {
        const p = originalPipeline();
        p.exec = async () => reply;
        return p;
      };
    };

    try {
      const recordInvalid = [
        [
          'missing threadId',
          (() => {
            const { threadId, ...rest } = base;
            return rest;
          })(),
        ],
        [
          'missing userId',
          (() => {
            const { userId, ...rest } = base;
            return rest;
          })(),
        ],
        ['targetCats with non-string member', { ...base, targetCats: '[123]' }],
        ['non-finite createdAt', { ...base, createdAt: 'abc' }],
      ];
      for (const [label, hash] of recordInvalid) {
        withReply([[null, hash]]);
        await assert.rejects(
          () => store.listRunningByThread('thread-r12', 'r12-user'),
          (err) => err instanceof Error,
          `record-invalid must fail closed, never become stale: ${label}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(await redis.smembers(setKey), [id], `index must survive: ${label}`);
      }
    } finally {
      redis.pipeline = originalPipeline;
    }
  });

  it('F297 (local R12 P1) — backfill: a record-invalid hash aborts the pass; the flag is only set by a fully valid scan', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    // 砚砚 R12 probe：status=banana / 缺 threadId 的 pre-deploy hash 被静默 skip 后
    // `runningIndexBackfilled=true` 永久置位 ⇒ 该 running 记录被**永久**漏报，而
    // owner-truth source 一路报成功 —— 与原始 bug 相同的 false-terminal 方向。
    // 正确语义：record-invalid = 未知 = abort 本轮 backfill（flag 不置位），修复后重试必须真重扫。
    const corruptShapes = [
      ['status outside the union', { status: 'banana' }],
      ['missing threadId', { threadId: undefined }],
    ];
    for (const [label, patch] of corruptShapes) {
      await cleanupPrefixedRedisKeys(redis, ['invoc:*', 'idemp:*']);
      const corruptId = 'r12-bf-corrupt';
      const goodId = 'r12-bf-good';
      const hash = (id, overrides) => {
        const full = {
          id,
          threadId: `thread-${id}`,
          userId: 'r12-bf-user',
          targetCats: '["opus"]',
          intent: 'execute',
          idempotencyKey: `idem-${id}`,
          status: 'running',
          userMessageId: '',
          error: '',
          createdAt: '1700000000000',
          updatedAt: '1700000000000',
          ...overrides,
        };
        return Object.fromEntries(Object.entries(full).filter(([, v]) => v !== undefined));
      };
      await redis.hset(`invoc:${corruptId}`, hash(corruptId, patch));
      await redis.hset(`invoc:${goodId}`, hash(goodId, {}));

      const freshStore = new RedisInvocationRecordStore(redis);
      await assert.rejects(
        () => freshStore.listRunningThreadIds('r12-bf-user'),
        (err) => err instanceof Error,
        `a record-invalid hash must abort backfill: ${label}`,
      );

      // 修复损坏 hash → 重试必须真的重扫（flag 未被置位）并浮出 pre-deploy running thread
      await redis.hset(`invoc:${corruptId}`, hash(corruptId, {}));
      assert.deepEqual(
        (await freshStore.listRunningThreadIds('r12-bf-user')).sort(),
        [`thread-${corruptId}`, `thread-${goodId}`],
        `the retry after repair must re-scan and surface both running threads: ${label}`,
      );
    }
  });

  it('F297 (local R12 P1) — scanAll fails closed on a corrupt hash instead of silently omitting it', async (t) => {
    if (!connected) return t.skip('Redis not connected');

    // scanAll 喂 zombie recovery 与 duty briefing 的 liveness 判断（filter running）。
    // 静默 skip 损坏记录 = zombie 永不恢复。上层各有 catch/degraded 语义，抛出是安全的。
    await cleanupPrefixedRedisKeys(redis, ['invoc:*', 'idemp:*']);
    const rec = await store.create({
      threadId: 'thread-sa',
      userId: 'sa-user',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'f297-sa',
      actionLeaseCarrier: { kind: 'none' },
    });
    await redis.hset('invoc:sa-corrupt', { id: 'sa-corrupt', status: 'banana' });

    await assert.rejects(
      () => store.scanAll(),
      (err) => err instanceof Error,
      'scanAll must not silently omit a corrupt record',
    );

    // id/key parity：hash id 与 key 内 id 不符 = 数据损坏，同样未知
    await redis.del('invoc:sa-corrupt');
    await redis.hset('invoc:sa-mismatch', {
      id: 'other-id',
      threadId: 'thread-sa',
      userId: 'sa-user',
      targetCats: '["opus"]',
      status: 'running',
      createdAt: '1700000000000',
      updatedAt: '1700000000000',
    });
    await assert.rejects(
      () => store.scanAll(),
      (err) => err instanceof Error,
      'scanAll must reject a hash whose id does not match its key',
    );

    await redis.del('invoc:sa-mismatch');
    const all = await store.scanAll();
    assert.deepEqual(
      all.map((r) => r.id),
      [rec.invocationId],
      'a clean keyspace scans normally',
    );
  });
});
