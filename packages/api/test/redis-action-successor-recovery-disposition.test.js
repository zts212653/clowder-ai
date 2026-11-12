import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runActionDueRecovery } from '../dist/domains/ball-custody/action-successor-due-recovery.js';
import { ActionSuccessorKeys } from '../dist/domains/ball-custody/action-successor-keys.js';
import { actionRecoveryLease as lease, withActionRecoveryRedis } from './helpers/action-recovery-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const isolated = { skip: redisIsolationSkipReason(process.env.REDIS_URL) };

test(
  'expired claims and corrupt metadata cannot restore a retry budget, even after derived indexes are deleted',
  isolated,
  async () => {
    await withActionRecoveryRedis(async ({ redis, store, seed }) => {
      const original = lease(3, false);
      await seed(original);
      await store.initializeRecovery();
      let snapshot = await store.recovery.read(original.leaseId, 'dispatch');
      await store.recovery.update(snapshot, 'dispatch', {
        ...snapshot.fact,
        attempts: 4,
        nextAttemptAt: 1,
        claim: { token: 'old-process', expiresAt: 1 },
      });
      await runActionDueRecovery({
        port: store.recovery,
        lease: original,
        lane: 'dispatch',
        now: 2,
        recover: async () => assert.fail('interrupted attempt is not replayed'),
      });
      snapshot = await store.recovery.read(original.leaseId, 'dispatch');
      assert.equal(snapshot.fact.attempts, 5);
      assert.equal(snapshot.fact.disposition, 'parked');
      assert.equal(
        snapshot.fact.nextAttemptAt,
        null,
        'unavailable owner retains queryable intent off the automatic queue',
      );
      const key = ActionSuccessorKeys.detail(original.leaseId);
      const raw = JSON.parse(await redis.get(key));
      raw._recovery.task = { attempts: 'broken' };
      await redis.set(key, JSON.stringify(raw));
      await store.initializeRecovery(true);
      snapshot = await store.recovery.read(original.leaseId, 'dispatch');
      assert.equal(snapshot.fact.disposition, 'parked');
      assert.equal(snapshot.fact.attempts, 5);
      const invalid = await store.recovery.read(original.leaseId, 'task');
      assert.equal(invalid.fact.disposition, 'needs_attention');
      await runActionDueRecovery({
        port: store.recovery,
        lease: original,
        lane: 'task',
        now: 3,
        recover: async () => assert.fail('corrupt metadata cannot auto-run'),
      });
      assert.equal((await store.recovery.read(original.leaseId, 'task')).fact.nextAttemptAt, null);
    });
  },
);

test(
  'identity mismatch is disposed across every recovery lane while retaining the original business record after index rebuild',
  isolated,
  async () => {
    await withActionRecoveryRedis(async ({ redis, store, seed }) => {
      const original = lease(8, false);
      await seed(original);
      await redis.set(ActionSuccessorKeys.identity(original), 'another-owner-detail');
      await store.initializeRecovery();
      for (const lane of ['return', 'dispatch', 'task']) {
        await runActionDueRecovery({
          port: store.recovery,
          lease: original,
          lane,
          now: 1,
          recover: async () => assert.fail('identity mismatch cannot execute'),
        });
        assert.equal((await store.recovery.read(original.leaseId, lane)).fact.nextAttemptAt, null);
      }
      await store.initializeRecovery(true);
      assert.equal((await store.listPendingDispatches()).length, 0);
      assert.deepEqual(await store.get(original.leaseId), {
        ...original,
        terminalPredicateState: { kind: 'predicate_backed' },
      });
    });
  },
);
