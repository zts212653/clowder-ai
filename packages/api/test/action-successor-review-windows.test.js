import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ActionSuccessorCompletionService } from '../dist/domains/ball-custody/ActionSuccessorCompletionService.js';
import { ActionSuccessorDispatchRecovery } from '../dist/domains/ball-custody/ActionSuccessorDispatchRecovery.js';
import { ActionSuccessorKeys } from '../dist/domains/ball-custody/action-successor-keys.js';
import { RedisActionSuccessorLeaseStore } from '../dist/domains/ball-custody/RedisActionSuccessorLeaseStore.js';
import { TaskActionSuccessorLifecycle } from '../dist/domains/ball-custody/TaskActionSuccessorLifecycle.js';
import { actionRecoveryLease } from './helpers/action-recovery-fixture.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

// The independent #6612 REDs exercised these real consumers, not a fabricated recovery outcome.
const fixture = ownedRedisFixture('1843-action-review-windows');
async function setup(numbers) {
  const redis = fixture.client(`${randomUUID()}:`),
    store = new RedisActionSuccessorLeaseStore(redis);
  const leases = numbers.map((n) => actionRecoveryLease(n, false));
  for (const lease of leases) {
    const key = ActionSuccessorKeys.detail(lease.leaseId);
    await redis.set(key, JSON.stringify(lease));
    await redis.set(ActionSuccessorKeys.identity(lease), `${redis.options.keyPrefix}${key}`);
    await redis.sadd(ActionSuccessorKeys.ALL, `${redis.options.keyPrefix}${key}`);
  }
  await store.initializeRecovery();
  return { store, leases };
}

test('a hung real dispatch freshness read releases the batch and cannot retire a lease after its deadline', async () => {
  const { store, leases } = await setup([1, 2]);
  let release, enter;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    entered = new Promise((resolve) => {
      enter = resolve;
    });
  const sweep = new ActionSuccessorDispatchRecovery({
    leaseStore: store,
    truthResolver: {
      resolveFreshness: async () => {
        enter();
        await gate;
        return { status: 'mismatch', evidenceRef: 'task:late' };
      },
    },
    loadProposal: async () => assert.fail('no late proposal read'),
    loadOwnerAuthProvenance: async () => assert.fail('no late auth'),
    deliver: async () => assert.fail('no late delivery'),
    recordProposalDelivery: async () => assert.fail('no late receipt'),
  });
  const cycle = sweep.runOnce();
  await entered;
  try {
    const round = await Promise.race([cycle, delay(5250).then(() => assert.fail('batch remained blocked'))]);
    assert.equal(round.scanned, 2);
    const before = await store.get(leases[0].leaseId);
    const untouched = await store.recovery.read(leases[1].leaseId, 'dispatch');
    assert.equal(untouched.fact.attempts, 0, 'unvisited work does not consume a failure');
    release();
    await delay(30);
    assert.deepEqual(await store.get(leases[0].leaseId), before, 'the late mismatch cannot retire the original lease');
  } finally {
    release();
    await cycle;
  }
});

test('real completion candidate CAS contention stays typed stale across five recovery rounds', async () => {
  const {
    store,
    leases: [lease],
  } = await setup([3]);
  let now = Date.now(),
    races = 0;
  const completion = new ActionSuccessorCompletionService(store, {
    resolveCompletion: async (predicate, candidate) => {
      await store.recordCompletionCandidate(lease.leaseId, {
        generation: lease.generation,
        catId: lease.holderCatIds[0],
        evidenceRefs: [`task:concurrent-${++races}:done:1`],
        now,
      });
      return {
        status: 'verified',
        predicateDigest: predicate.digest,
        freshnessKey: predicate.freshnessKey,
        evidenceRef: candidate.evidenceRefs[0],
        candidateRevision: candidate.candidateRevision,
        evidenceDigest: candidate.evidenceDigest,
      };
    },
  });
  const outcomes = [];
  const lifecycle = new TaskActionSuccessorLifecycle({
    leaseStore: store,
    completionService: {
      complete: async (input) => {
        const result = await completion.complete(input);
        outcomes.push(result);
        return result;
      },
    },
    now: () => now,
  });
  const tasks = {
    get: async (id) => ({
      id,
      status: 'done',
      kind: 'work',
      subjectKey: 'eval-case:review',
      ownerCatId: lease.holderCatIds[0],
      threadId: lease.holderThreadId,
      updatedAt: now,
    }),
  };
  for (let n = 0; n < 5; n++) {
    await lifecycle.reconcileDoneTasks(tasks);
    now += 60_000;
  }
  const current = await store.recovery.read(lease.leaseId, 'task');
  assert.equal(current.fact.attempts, 0);
  assert.equal(current.fact.disposition, undefined);
  assert.equal(races, 5);
  assert.deepEqual(
    outcomes.map((result) => result.outcome),
    Array(5).fill('stale'),
  );
  assert.ok(outcomes.every((result) => result.reason === 'candidate_changed'));
});
