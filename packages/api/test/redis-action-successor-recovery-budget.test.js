import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runActionDueRecovery } from '../dist/domains/ball-custody/action-successor-due-recovery.js';
import { actionRecoveryLease as lease, withActionRecoveryRedis } from './helpers/action-recovery-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const isolated = { skip: redisIsolationSkipReason(process.env.REDIS_URL) };
test(
  'five actual failures park only the original lane and remain off the queue across restart and rebuild',
  isolated,
  async () => {
    await withActionRecoveryRedis(async ({ redis, store, seed }) => {
      const original = lease(1, false);
      await seed(original);
      await store.initializeRecovery();
      let attempted = 0;
      const recover = async () => {
        attempted++;
        throw new Error('backend read unavailable');
      };
      let now = 1;
      for (let n = 0; n < 5; n++) {
        await runActionDueRecovery({ port: store.recovery, lease: original, lane: 'dispatch', now, recover });
        now = (await store.recovery.read(original.leaseId, 'dispatch')).fact.nextAttemptAt;
      }
      let snapshot = await store.recovery.read(original.leaseId, 'dispatch');
      assert.equal(snapshot.fact.disposition, 'parked');
      assert.equal(snapshot.fact.attempts, 5);
      assert.equal(snapshot.lease.status, original.status);
      assert.equal(snapshot.lease.revision, original.revision);
      const { RedisActionSuccessorLeaseStore } = await import(
        '../dist/domains/ball-custody/RedisActionSuccessorLeaseStore.js'
      );
      const restarted = new RedisActionSuccessorLeaseStore(redis);
      await restarted.initializeRecovery(true);
      await runActionDueRecovery({ port: restarted.recovery, lease: original, lane: 'dispatch', now, recover });
      snapshot = await restarted.recovery.read(original.leaseId, 'dispatch');
      assert.equal(snapshot.fact.nextAttemptAt, null);
      assert.equal(attempted, 5);
      assert.equal((await restarted.listPendingDispatches()).length, 0);
      assert.equal(
        (await restarted.listActiveTaskLeases()).length,
        1,
        'independent task lane retains its responsibility',
      );
    });
  },
);

test(
  'waiting and stale contenders never consume failure budget; canonical CAS preserves concurrent recovery metadata',
  isolated,
  async () => {
    await withActionRecoveryRedis(async ({ store, seed }) => {
      const original = lease(2, false);
      await seed(original);
      await store.initializeRecovery();
      let attempts = 0;
      for (let n = 0; n < 8; n++) {
        await runActionDueRecovery({
          port: store.recovery,
          lease: original,
          lane: 'dispatch',
          now: n * 30_000,
          recover: async () => {
            attempts++;
            return { kind: 'waiting' };
          },
        });
      }
      let snapshot = await store.recovery.read(original.leaseId, 'dispatch');
      assert.equal(snapshot.fact.attempts, 0);
      assert.equal(attempts, 8);
      await store.recovery.update(snapshot, 'dispatch', { ...snapshot.fact, attempts: 4, nextAttemptAt: 0 });
      const recorded = await store.recordDispatchDeliveryAttempt(original.leaseId, {
        expectedGeneration: original.generation,
        expectedRevision: original.revision,
        expectedPredicateDigest: original.terminalPredicate.digest,
        freshnessEvidenceRef: 'test:fresh',
        now: 300_000,
      });
      assert.equal(recorded.outcome, 'recorded');
      assert.equal((await store.recovery.read(original.leaseId, 'dispatch')).fact.attempts, 4);
      const stale = await runActionDueRecovery({
        port: store.recovery,
        lease: original,
        lane: 'dispatch',
        now: 300_000,
        recover: async () => {
          throw new Error('stale candidate must not enter handler');
        },
      });
      assert.equal(stale.kind, 'stale');
      assert.equal((await store.recovery.read(original.leaseId, 'dispatch')).fact.attempts, 4);
      snapshot = await store.recovery.read(original.leaseId, 'dispatch');
      await store.recovery.update(snapshot, 'dispatch', { ...snapshot.fact, nextAttemptAt: 0 });
      let entered, release;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise((resolve) => {
        release = resolve;
      });
      let handlers = 0;
      const winner = runActionDueRecovery({
        port: store.recovery,
        lease: recorded.lease,
        lane: 'dispatch',
        now: 300_000,
        recover: async () => {
          handlers++;
          entered();
          await barrier;
          return { kind: 'waiting' };
        },
      });
      await started;
      const contender = await runActionDueRecovery({
        port: store.recovery,
        lease: recorded.lease,
        lane: 'dispatch',
        now: 300_000,
        recover: async () => {
          handlers++;
          return { kind: 'waiting' };
        },
      });
      release();
      await winner;
      assert.equal(contender.kind, 'stale');
      assert.equal(handlers, 1);
      assert.equal((await store.recovery.read(original.leaseId, 'dispatch')).fact.attempts, 4);
    });
  },
);

test(
  'finishing a claimed observation tolerates another lane CAS without falsely treating it as an interrupted attempt',
  isolated,
  async () => {
    await withActionRecoveryRedis(async ({ store, seed }) => {
      const original = lease(9, false);
      await seed(original);
      await store.initializeRecovery();
      let interleave = false;
      const port = {
        read: (id, lane) => store.recovery.read(id, lane),
        update: async (snapshot, lane, fact, fenceBusiness, token) => {
          if (interleave) {
            interleave = false;
            const other = await store.recovery.read(original.leaseId, 'task');
            await store.recovery.update(other, 'task', { ...other.fact, nextAttemptAt: 777 });
          }
          return store.recovery.update(snapshot, lane, fact, fenceBusiness, token);
        },
      };
      await runActionDueRecovery({
        port,
        lease: original,
        lane: 'dispatch',
        now: 1,
        recover: async () => {
          interleave = true;
          return { kind: 'waiting' };
        },
      });
      const snapshot = await store.recovery.read(original.leaseId, 'dispatch');
      assert.equal(snapshot.fact.claim, undefined);
      assert.equal(snapshot.fact.nextAttemptAt, 30_001);
      assert.equal(snapshot.fact.attempts, 0);
      assert.equal((await store.recovery.read(original.leaseId, 'task')).fact.nextAttemptAt, 777);
    });
  },
);
