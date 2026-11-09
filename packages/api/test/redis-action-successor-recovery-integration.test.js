import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionSuccessorDispatchRecovery } from '../dist/domains/ball-custody/ActionSuccessorDispatchRecovery.js';
import { ActionSuccessorRecoverySweep } from '../dist/domains/ball-custody/ActionSuccessorRecoverySweep.js';
import { TaskActionSuccessorLifecycle } from '../dist/domains/ball-custody/TaskActionSuccessorLifecycle.js';
import { actionRecoveryLease as lease, withActionRecoveryRedis } from './helpers/action-recovery-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const isolated = { skip: redisIsolationSkipReason(process.env.REDIS_URL) };

test(
  'real dispatch loop isolates a failing resolver, parks after five reads, and keeps a normal wait healthy',
  isolated,
  async () => {
    await withActionRecoveryRedis(async ({ store, seed }) => {
      const bad = lease(1, false),
        good = lease(2, false);
      await seed(bad);
      await seed(good);
      await store.initializeRecovery();
      let now = Date.now();
      const reads = [];
      const recovery = new ActionSuccessorDispatchRecovery({
        leaseStore: store,
        now: () => now,
        truthResolver: {
          resolveFreshness: async (predicate) => {
            reads.push(predicate.subjectRef);
            if (predicate.subjectRef === bad.subjectRef) throw new Error('bad subject read');
            return { status: 'insufficient' };
          },
        },
        loadProposal: async () => assert.fail('insufficient truth never admits a carrier'),
        loadOwnerAuthProvenance: async () => assert.fail('no auth reads before truth'),
        recordProposalDelivery: async () => assert.fail('no delivery'),
        deliver: async () => assert.fail('no execution'),
      });
      for (let n = 0; n < 8; n++) {
        await recovery.runOnce();
        now += 30_000;
      }
      assert.equal(reads.filter((x) => x === bad.subjectRef).length, 5);
      assert.equal(reads.filter((x) => x === good.subjectRef).length, 8);
      assert.equal((await store.recovery.read(bad.leaseId, 'dispatch')).fact.disposition, 'parked');
      assert.equal((await store.recovery.read(good.leaseId, 'dispatch')).fact.attempts, 0);
      assert.equal((await store.recovery.read(bad.leaseId, 'dispatch')).fact.notification, undefined);
    });
  },
);

test(
  'real return loop settles its healthy neighbor while one delivery throws, without retrying the healthy carrier',
  isolated,
  async () => {
    await withActionRecoveryRedis(async ({ store, seed }) => {
      const bad = { ...lease(3, false), returnDeliveryState: 'pending' };
      const good = { ...lease(4, false), returnDeliveryState: 'pending' };
      await seed(bad);
      await seed(good);
      await store.initializeRecovery();
      let now = Date.now(),
        badCalls = 0,
        goodCalls = 0;
      const recovery = new ActionSuccessorRecoverySweep({
        leaseStore: store,
        now: () => now,
        deliverReturnCarrier: async (carrier) => {
          if (carrier.idempotencyKey.includes(bad.leaseId + ':')) {
            badCalls++;
            throw new Error('transport read failed');
          }
          goodCalls++;
          return { outcome: 'completed', invocationId: 'original-invocation' };
        },
      });
      for (let n = 0; n < 8; n++) {
        await recovery.runOnce();
        now += 30_000;
      }
      assert.equal(badCalls, 5);
      assert.equal(goodCalls, 1);
      assert.equal((await store.get(good.leaseId)).returnDeliveryState, 'delivered');
      assert.equal((await store.recovery.read(bad.leaseId, 'return')).fact.disposition, 'parked');
    });
  },
);

test(
  'real task loop keeps a live wait off the error budget and stops retrying one unavailable task',
  isolated,
  async () => {
    await withActionRecoveryRedis(async ({ store, seed }) => {
      const bad = lease(5, false),
        good = lease(6, false);
      await seed(bad);
      await seed(good);
      await store.initializeRecovery();
      let now = Date.now(),
        failedReads = 0,
        normalReads = 0;
      const lifecycle = new TaskActionSuccessorLifecycle({
        leaseStore: store,
        now: () => now,
        completionService: { complete: async () => assert.fail('live task cannot be declared complete') },
      });
      const tasks = {
        get: async (id) => {
          if (id === bad.subjectRef.slice('subject:task:'.length)) {
            failedReads++;
            throw new Error('unavailable task');
          }
          normalReads++;
          return { status: 'doing', kind: 'work', subjectKey: 'eval-case:kept-contract' };
        },
      };
      for (let n = 0; n < 8; n++) {
        await lifecycle.reconcileDoneTasks(tasks);
        now += 30_000;
      }
      assert.equal(failedReads, 5);
      assert.equal(normalReads, 8);
      assert.equal((await store.recovery.read(bad.leaseId, 'task')).fact.disposition, 'parked');
      assert.equal((await store.recovery.read(good.leaseId, 'task')).fact.attempts, 0);
    });
  },
);
