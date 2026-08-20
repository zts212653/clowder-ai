/**
 * InvocationRecordStore Tests
 * 测试内存 InvocationRecord 存储
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('InvocationRecordStore', () => {
  test('create() rejects an unclassified action-lease carrier', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    assert.throws(
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

  test('create() returns created outcome with invocationId', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const result = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'key-1',
      actionLeaseCarrier: { kind: 'none' },
    });

    assert.equal(result.outcome, 'created');
    assert.ok(result.invocationId.length > 0);
    assert.equal(store.size, 1);
  });

  test('create() record has correct initial state', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus', 'codex'],
      intent: 'ideate',
      idempotencyKey: 'key-2',
      actionLeaseCarrier: { kind: 'none' },
    });

    const record = store.get(invocationId);
    assert.ok(record);
    assert.equal(record.status, 'queued');
    assert.equal(record.userMessageId, null);
    assert.equal(record.threadId, 'thread-1');
    assert.equal(record.userId, 'user-1');
    assert.deepEqual(record.targetCats, ['opus', 'codex']);
    assert.equal(record.intent, 'ideate');
    assert.equal(record.idempotencyKey, 'key-2');
    assert.ok(record.createdAt > 0);
    assert.equal(record.createdAt, record.updatedAt);
  });

  test('create() classifies ordinary and action-successor invocation carriers', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const { invocationId: ordinaryInvocationId } = store.create({
      threadId: 'thread-review',
      userId: 'user-review',
      targetCats: ['codex-sol'],
      intent: 'execute',
      idempotencyKey: 'review-no-action-lease',
      actionLeaseCarrier: { kind: 'none' },
    });
    const { invocationId } = store.create({
      threadId: 'thread-review',
      userId: 'user-review',
      targetCats: ['codex-sol'],
      intent: 'execute',
      idempotencyKey: 'review-action-lease',
      actionLeaseCarrier: {
        kind: 'action_successor',
        leaseId: 'lease-review-1',
        generation: 2,
      },
    });

    assert.deepEqual(store.get(ordinaryInvocationId).actionLeaseCarrier, { kind: 'none' });
    assert.deepEqual(store.get(invocationId).actionLeaseCarrier, {
      kind: 'action_successor',
      leaseId: 'lease-review-1',
      generation: 2,
    });
  });

  test('create() persists an exact wait continuation carrier without promoting its owner fence', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const waitContinuationCarrier = {
      v: 1,
      waitId: 'task-pr-7',
      outcomeId: 'wait:pr:owner/repo#7:g4:matched',
      ownerFence: { kind: 'action_successor', leaseId: 'lease-wait-4', generation: 4 },
    };
    const { invocationId } = store.create({
      threadId: 'thread-wait',
      userId: 'user-wait',
      targetCats: ['codex-sol'],
      intent: 'execute',
      idempotencyKey: 'wait-carrier',
      actionLeaseCarrier: { kind: 'none' },
      waitContinuationCarrier,
    });

    assert.deepEqual(store.get(invocationId).waitContinuationCarrier, waitContinuationCarrier);
    assert.deepEqual(store.get(invocationId).actionLeaseCarrier, { kind: 'none' });
  });

  test('create() rejects a malformed wait continuation carrier before recording it', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    assert.throws(
      () =>
        store.create({
          threadId: 'thread-wait-invalid',
          userId: 'user-wait',
          targetCats: ['codex-sol'],
          intent: 'execute',
          idempotencyKey: 'wait-carrier-invalid',
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
    assert.equal(store.size, 0);
  });

  test('idempotency dedup returns duplicate on same key', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const first = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'dup-key',
      actionLeaseCarrier: { kind: 'none' },
    });
    assert.equal(first.outcome, 'created');

    const second = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'dup-key',
      actionLeaseCarrier: { kind: 'none' },
    });
    assert.equal(second.outcome, 'duplicate');
    assert.equal(second.invocationId, first.invocationId);
    assert.equal(store.size, 1);
  });

  test('different threadId with same key does not dedup', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const first = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'same-key',
      actionLeaseCarrier: { kind: 'none' },
    });
    const second = store.create({
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
    assert.equal(store.size, 2);
  });

  test('get() returns null for non-existent id', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    assert.equal(store.get('non-existent'), null);
  });

  test('update() changes status and updatedAt', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'upd-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    const before = store.get(invocationId);
    assert.equal(before.status, 'queued');

    // Small delay to ensure updatedAt changes
    await new Promise((r) => setTimeout(r, 5));

    const updated = store.update(invocationId, { status: 'running' });
    assert.equal(updated.status, 'running');
    assert.ok(updated.updatedAt >= before.updatedAt);
  });

  test('update() backfills userMessageId', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'backfill-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    assert.equal(store.get(invocationId).userMessageId, null);

    store.update(invocationId, { userMessageId: 'msg-123' });
    assert.equal(store.get(invocationId).userMessageId, 'msg-123');
  });

  test('F254 Phase E persists typed closure custody fields', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );
    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-f254',
      userId: 'user-f254',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'f254-custody',
      actionLeaseCarrier: { kind: 'none' },
    });
    const updated = store.update(invocationId, {
      freshnessClosureId: 'closure-1',
      freshnessInputFrontierMessageId: 'msg-frontier',
      freshnessClosureStatus: 'running',
    });

    assert.equal(updated.freshnessClosureId, 'closure-1');
    assert.equal(updated.freshnessInputFrontierMessageId, 'msg-frontier');
    assert.equal(updated.freshnessClosureStatus, 'running');
  });

  test('persists a durable connector execution-start receipt while running', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );
    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-connector-start',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'connector-start-receipt',
      actionLeaseCarrier: { kind: 'none' },
    });
    store.update(invocationId, { status: 'running', expectedStatus: 'queued' });

    const updated = store.update(invocationId, {
      executionStartedAt: 1_700_000_000_000,
      expectedStatus: 'running',
    });

    assert.equal(updated.executionStartedAt, 1_700_000_000_000);
    assert.equal(store.get(invocationId).executionStartedAt, 1_700_000_000_000);
  });

  test('clears the previous execution-start receipt when a failed record starts a new attempt', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );
    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-connector-retry',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'connector-retry-receipt',
      actionLeaseCarrier: { kind: 'none' },
    });
    store.update(invocationId, { status: 'running', expectedStatus: 'queued' });
    store.update(invocationId, {
      executionStartedAt: 1_700_000_000_000,
      expectedStatus: 'running',
    });
    store.update(invocationId, { status: 'failed', error: 'process_restart', expectedStatus: 'running' });

    const retried = store.update(invocationId, {
      status: 'running',
      error: '',
      expectedStatus: 'failed',
    });

    assert.equal(retried.executionStartedAt, undefined);
    assert.equal(store.get(invocationId).executionStartedAt, undefined);
  });

  test('update() sets error on failed status', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'err-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    store.update(invocationId, { status: 'running' });
    store.update(invocationId, { status: 'failed', error: 'CLI timeout' });
    const record = store.get(invocationId);
    assert.equal(record.status, 'failed');
    assert.equal(record.error, 'CLI timeout');
  });

  test('F8: update() stores usageByCat and get() returns it', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus', 'codex'],
      intent: 'ideate',
      idempotencyKey: 'usage-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    const usageByCat = {
      opus: { inputTokens: 1000, outputTokens: 500, costUsd: 0.03 },
      codex: { inputTokens: 200, outputTokens: 100 },
    };

    store.update(invocationId, { status: 'running' });
    store.update(invocationId, { status: 'succeeded', usageByCat });

    const record = store.get(invocationId);
    assert.ok(record);
    assert.equal(record.status, 'succeeded');
    assert.deepEqual(record.usageByCat, usageByCat);
    assert.equal(record.usageByCat.opus.inputTokens, 1000);
    assert.equal(record.usageByCat.codex.outputTokens, 100);
  });

  test('update() returns null for non-existent id', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    assert.equal(store.update('non-existent', { status: 'running' }), null);
  });

  test('getByIdempotencyKey() finds record by composite key', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'lookup-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    const found = store.getByIdempotencyKey('thread-1', 'user-1', 'lookup-key');
    assert.ok(found);
    assert.equal(found.id, invocationId);
  });

  test('getByIdempotencyKey() returns null for wrong scope', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'scoped-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    assert.equal(store.getByIdempotencyKey('thread-2', 'user-1', 'scoped-key'), null);
    assert.equal(store.getByIdempotencyKey('thread-1', 'user-2', 'scoped-key'), null);
  });

  test('bounded capacity evicts oldest records', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore({ maxRecords: 3 });
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const result = store.create({
        threadId: 'thread-1',
        userId: 'user-1',
        targetCats: ['opus'],
        intent: 'execute',
        idempotencyKey: `cap-key-${i}`,
        actionLeaseCarrier: { kind: 'none' },
      });
      ids.push(result.invocationId);
    }

    assert.equal(store.size, 3);
    // Oldest records should be evicted
    assert.equal(store.get(ids[0]), null);
    assert.equal(store.get(ids[1]), null);
    // Newest should remain
    assert.ok(store.get(ids[2]));
    assert.ok(store.get(ids[3]));
    assert.ok(store.get(ids[4]));
  });

  test('F194 Phase B — listRunningByThread returns only running + matching thread/user', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );
    const store = new InvocationRecordStore();

    // Setup: 5 records across thread/user/status combinations
    const r1 = store.create({
      threadId: 'thread-A',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'k1',
      actionLeaseCarrier: { kind: 'none' },
    });
    const r2 = store.create({
      threadId: 'thread-A',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'k2',
      actionLeaseCarrier: { kind: 'none' },
    });
    const r3 = store.create({
      threadId: 'thread-A',
      userId: 'user-2', // different user
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'k3',
      actionLeaseCarrier: { kind: 'none' },
    });
    const r4 = store.create({
      threadId: 'thread-B', // different thread
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'k4',
      actionLeaseCarrier: { kind: 'none' },
    });
    store.create({
      threadId: 'thread-A',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'k5',
      actionLeaseCarrier: { kind: 'none' },
    }); // r5 stays 'queued' — verifies non-running records are excluded

    // Transition statuses
    store.update(r1.invocationId, { status: 'running' }); // ✅ matches
    store.update(r2.invocationId, { status: 'running' }); // ✅ matches
    store.update(r2.invocationId, { status: 'succeeded' }); // ❌ no longer running
    store.update(r3.invocationId, { status: 'running' }); // ❌ different user
    store.update(r4.invocationId, { status: 'running' }); // ❌ different thread
    // r5 stays 'queued' — ❌ not running

    const running = store.listRunningByThread('thread-A', 'user-1');
    const ids = running.map((r) => r.id).sort();
    assert.deepEqual(ids, [r1.invocationId].sort(), 'only r1 (running + thread-A + user-1) returned');

    // Sanity: empty thread returns empty
    assert.deepEqual(store.listRunningByThread('thread-nonexistent', 'user-1'), []);
    // Sanity: empty user returns empty
    assert.deepEqual(store.listRunningByThread('thread-A', 'user-nonexistent'), []);
  });

  test('F194 Phase B — listRunningByThread reflects status transitions in real time', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );
    const store = new InvocationRecordStore();

    const r = store.create({
      threadId: 'thread-X',
      userId: 'user-Y',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'transition-key',
      actionLeaseCarrier: { kind: 'none' },
    });

    // queued → not in list
    assert.equal(store.listRunningByThread('thread-X', 'user-Y').length, 0);

    // queued → running
    store.update(r.invocationId, { status: 'running' });
    assert.equal(store.listRunningByThread('thread-X', 'user-Y').length, 1);

    // running → succeeded → no longer in list
    store.update(r.invocationId, { status: 'succeeded' });
    assert.equal(store.listRunningByThread('thread-X', 'user-Y').length, 0);
  });

  test('F254 persists the exact successful targets of a shared invocation', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );
    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-f254-shared',
      userId: 'user-f254',
      targetCats: ['opus', 'codex'],
      intent: 'execute',
      idempotencyKey: 'f254-shared-success',
      actionLeaseCarrier: { kind: 'none' },
    });

    store.update(invocationId, { status: 'running' });
    assert.throws(
      () =>
        store.update(invocationId, {
          status: 'succeeded',
          successfulCatIds: ['gemini'],
        }),
      /successfulCatIds.*targetCats/i,
      'invalid input must be distinguishable from a CAS rejection',
    );
    assert.equal(store.get(invocationId).status, 'running');
    assert.throws(
      () => store.update(invocationId, { status: 'succeeded', successfulCatIds: [] }),
      /successfulCatIds.*non-empty/i,
      'a non-empty target invocation cannot succeed without an exact target witness',
    );
    const succeeded = store.update(invocationId, {
      status: 'succeeded',
      successfulCatIds: ['opus'],
    });

    assert.deepEqual(succeeded.successfulCatIds, ['opus']);
    assert.deepEqual(store.get(invocationId).successfulCatIds, ['opus']);
    assert.throws(() => succeeded.successfulCatIds.push('codex'), TypeError);

    assert.throws(
      () => store.update(invocationId, { successfulCatIds: ['codex'] }),
      /successfulCatIds.*succeeded/i,
      'the terminal witness is immutable outside the succeeded transition',
    );
  });
});
