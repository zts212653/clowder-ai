/**
 * F167 S.1-c — ActionSuccessor return carrier recovery.
 *
 * Custody already moved in the lease CAS. The sweep only repairs transport:
 * it re-enqueues the exact generation fence and marks delivery after the
 * carrier exists, without creating another responsibility record.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function returnedLease(overrides = {}) {
  return {
    leaseId: 'lease-1',
    key: 'user-1\npr:owner/repo#3019\nreview\nreviewer',
    tenantScope: 'user-1',
    subjectRef: 'pr:owner/repo#3019',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    holderCatIds: ['codex-sol'],
    holderThreadId: 'thread-source',
    predecessorCatId: 'codex-terra',
    predecessorThreadId: 'thread-review',
    issuerStandingEvidenceRef: 'grounding:return-1',
    dispatchId: 'return:lease-1:g2',
    claimOrigin: 'structured_transfer',
    generation: 2,
    status: 'active',
    holderOutcomes: {},
    completionCandidates: {},
    evidenceRefs: ['grounding:return-1'],
    returnDeliveryState: 'pending',
    returnDeliveryEvidenceRef: 'grounding:return-1',
    returnDeliveryAttemptCount: 0,
    returnDeliverySlaUntil: 2_000,
    returnTransitions: [],
    terminalPredicateState: { kind: 'legacy_predicate_absent' },
    revision: 2,
    createdAt: 500,
    updatedAt: 1_000,
    ...overrides,
  };
}

function harness(options = {}) {
  let lease = options.lease ?? returnedLease();
  let now = options.now ?? 1_500;
  const deliveries = [];
  const attempts = [];
  const delivered = [];
  const overdue = [];
  const transportOutcomes = [
    ...(options.transportOutcomes ?? [{ outcome: 'completed', invocationId: 'invocation-1' }]),
  ];

  const deps = {
    leaseStore: {
      async listPendingReturns() {
        return lease.returnDeliveryState === 'pending' || lease.returnDeliveryState === 'overdue' ? [lease] : [];
      },
      async recordReturnDeliveryAttempt(id, input) {
        attempts.push({ id, input });
        if (id !== lease.leaseId || input.expectedGeneration !== lease.generation) {
          return { outcome: 'stale_generation', lease };
        }
        const becameOverdue = lease.returnDeliveryState === 'pending' && now >= lease.returnDeliverySlaUntil;
        lease = {
          ...lease,
          returnDeliveryState: becameOverdue ? 'overdue' : lease.returnDeliveryState,
          returnDeliveryAttemptCount: (lease.returnDeliveryAttemptCount ?? 0) + 1,
          returnDeliveryLastAttemptAt: now,
          ...(becameOverdue ? { returnDeliveryOverdueObservedAt: now } : {}),
          revision: lease.revision + 1,
          updatedAt: now,
        };
        return { outcome: 'recorded', lease, becameOverdue };
      },
      async markReturnDelivered(id, input) {
        delivered.push({ id, input });
        if (id !== lease.leaseId || input.expectedGeneration !== lease.generation) {
          return { outcome: 'stale_generation', lease };
        }
        lease = {
          ...lease,
          returnDeliveryState: 'delivered',
          returnDeliveryEvidenceRef: input.evidenceRef,
          revision: lease.revision + 1,
          updatedAt: input.now,
        };
        return { outcome: 'delivered', lease };
      },
    },
    async deliverReturnCarrier(input) {
      deliveries.push(input);
      const outcome = transportOutcomes.shift() ?? { outcome: 'unavailable' };
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    now: () => now,
    onOverdue: (input) => overdue.push(input),
  };

  return {
    deps,
    deliveries,
    attempts,
    delivered,
    overdue,
    lease: () => lease,
    setNow(value) {
      now = value;
    },
  };
}

async function loadSweep() {
  return import('../dist/domains/ball-custody/ActionSuccessorRecoverySweep.js');
}

describe('F167 S.1-c ActionSuccessorRecoverySweep', () => {
  test('re-enqueues the persisted predecessor route and marks the exact generation delivered', async () => {
    const { ActionSuccessorRecoverySweep } = await loadSweep();
    const h = harness();
    const sweep = new ActionSuccessorRecoverySweep(h.deps);

    assert.deepEqual(await sweep.runOnce(), { scanned: 1, delivered: 1, pending: 0, overdue: 0 });
    assert.equal(h.deliveries.length, 1);
    assert.deepEqual(h.deliveries[0], {
      threadId: 'thread-source',
      userId: 'user-1',
      targetCatId: 'codex-sol',
      callerCatId: 'codex-terra',
      content: '[ActionSuccessor return recovery]\nlease=lease-1 generation=2 subject=pr:owner/repo#3019',
      idempotencyKey: 'action-return:lease-1:2:codex-sol',
      fence: {
        leaseId: 'lease-1',
        generation: 2,
        dispatchId: 'return:lease-1:g2',
      },
    });
    assert.equal(h.attempts.length, 1);
    assert.deepEqual(h.delivered, [
      {
        id: 'lease-1',
        input: {
          expectedGeneration: 2,
          evidenceRef: 'invocation:invocation-1',
          now: 1_500,
        },
      },
    ]);
    assert.equal(h.lease().returnDeliveryState, 'delivered');
  });

  test('keeps custody pending across transport failure and retries idempotently', async () => {
    const { ActionSuccessorRecoverySweep } = await loadSweep();
    const h = harness({
      transportOutcomes: [
        new Error('queue unavailable'),
        { outcome: 'enqueued' },
        { outcome: 'completed', invocationId: 'invocation-1' },
      ],
    });
    const sweep = new ActionSuccessorRecoverySweep(h.deps);

    assert.deepEqual(await sweep.runOnce(), { scanned: 1, delivered: 0, pending: 1, overdue: 0 });
    assert.equal(h.lease().returnDeliveryState, 'pending');
    assert.equal(h.delivered.length, 0);

    assert.deepEqual(await sweep.runOnce(), { scanned: 1, delivered: 0, pending: 1, overdue: 0 });
    assert.equal(h.deliveries[0].idempotencyKey, h.deliveries[1].idempotencyKey);
    assert.equal(h.delivered.length, 0, 'volatile enqueue must not retire return custody');

    assert.deepEqual(await sweep.runOnce(), { scanned: 1, delivered: 1, pending: 0, overdue: 0 });
    assert.equal(h.deliveries[1].idempotencyKey, h.deliveries[2].idempotencyKey);
    assert.equal(h.lease().returnDeliveryAttemptCount, 3);
  });

  test('restart before InvocationRecord creation re-delivers one exact generation identity', async () => {
    const { ActionSuccessorRecoverySweep } = await loadSweep();
    const h = harness({
      transportOutcomes: [
        { outcome: 'enqueued' },
        { outcome: 'enqueued' },
        { outcome: 'completed', invocationId: 'invocation-after-restart' },
      ],
    });
    const sweep = new ActionSuccessorRecoverySweep(h.deps);

    assert.deepEqual(await sweep.runOnce(), { scanned: 1, delivered: 0, pending: 1, overdue: 0 });
    assert.deepEqual(await sweep.runOnce(), { scanned: 1, delivered: 0, pending: 1, overdue: 0 });
    assert.equal(h.delivered.length, 0);
    assert.equal(h.deliveries[0].idempotencyKey, h.deliveries[1].idempotencyKey);
    assert.deepEqual(h.deliveries[0].fence, h.deliveries[1].fence);

    assert.deepEqual(await sweep.runOnce(), { scanned: 1, delivered: 1, pending: 0, overdue: 0 });
    assert.equal(h.delivered.length, 1, 'the durable carrier retires the exact generation once');
    assert.equal(h.delivered[0].input.evidenceRef, 'invocation:invocation-after-restart');
  });

  test('records overdue once and keeps retrying the same owner without escalating custody', async () => {
    const { ActionSuccessorRecoverySweep } = await loadSweep();
    const h = harness({
      now: 3_000,
      transportOutcomes: [{ outcome: 'unavailable' }, { outcome: 'unavailable' }],
    });
    const sweep = new ActionSuccessorRecoverySweep(h.deps);

    assert.deepEqual(await sweep.runOnce(), { scanned: 1, delivered: 0, pending: 1, overdue: 1 });
    assert.equal(h.lease().returnDeliveryState, 'overdue');
    assert.equal(h.overdue.length, 1);
    assert.equal(h.overdue[0].leaseId, 'lease-1');

    assert.deepEqual(await sweep.runOnce(), { scanned: 1, delivered: 0, pending: 1, overdue: 1 });
    assert.equal(h.overdue.length, 1, 'the same overdue episode must not be counted twice');
    assert.deepEqual(h.lease().holderCatIds, ['codex-sol'], 'transport health must not rewrite custody');
  });
});
