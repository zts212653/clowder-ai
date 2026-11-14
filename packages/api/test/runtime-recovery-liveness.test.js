import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { ActionSuccessorDispatchRecovery } from '../dist/domains/ball-custody/ActionSuccessorDispatchRecovery.js';
import { ActionSuccessorRecoverySweep } from '../dist/domains/ball-custody/ActionSuccessorRecoverySweep.js';
import {
  buildAdmissionFactIdempotencyKey,
  ManagedCommandWakeRecoverySweep,
} from '../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import { isolateManagedJobData } from './helpers/isolated-managed-job-data.js';

isolateManagedJobData();

test('recovery cycles coalesce census through completion and recover after a rejected cycle', async () => {
  // Reconciliation must also tolerate a retained job whose carrier task is gone.
  // Seed it here so this coverage does not depend on another test's ledger.
  const jobs = new ManagedJobService();
  const principal = { userId: 'liveness-user', threadId: 'liveness-thread', catId: 'codex' };
  const job = await jobs.submit(principal, {
    command: 'true',
    cwd: process.cwd(),
    originTaskId: 'absent-liveness-task',
    originInvocationId: 'liveness-invocation',
    idempotencyKey: 'retained-job',
    executionSlaMs: 1000,
    wakeTarget: principal,
  });
  jobs.cancel(principal, job.jobId);
  for (const kind of ['returns', 'dispatches', 'managed']) {
    let scans = 0;
    let enter;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    let release;
    const pause = new Promise((resolve) => {
      release = resolve;
    });
    const scan = async () => {
      scans++;
      enter();
      await pause;
      return [];
    };
    const history = new MessageStore();
    let historyReads = 0;
    let historyWrites = 0;
    const task = {
      id: 'hold-ball-liveness',
      templateId: 'reminder',
      trigger: { type: 'once', fireAt: 60_000 },
      deliveryThreadId: principal.threadId,
      createdBy: 'hold-ball:codex',
      createdAt: new Date(1000).toISOString(),
      enabled: true,
      params: {
        triggerUserId: principal.userId,
        holdLifecycle: {
          mode: 'wake_when',
          status: 'active',
          createdBy: 'hold-ball:codex',
          managedCommand: {
            state: 'command_running',
            command: 'true',
            startedAt: 1000,
            admissionFact: 'original admission',
            admissionFactAppended: false,
          },
        },
      },
    };
    const sweep =
      kind === 'returns'
        ? new ActionSuccessorRecoverySweep({ leaseStore: { listPendingReturns: scan } })
        : kind === 'dispatches'
          ? new ActionSuccessorDispatchRecovery({ leaseStore: { listPendingDispatches: scan } })
          : new ManagedCommandWakeRecoverySweep({
              dynamicTaskStore: {
                getById: (id) => (id === task.id ? task : undefined),
                getAll: () => {
                  scans++;
                  return [task];
                },
                updateParamsIfCurrent(id, expected, params) {
                  if (id !== task.id || task.params !== expected) return false;
                  task.params = params;
                  return true;
                },
              },
              messageStore: {
                async getByIdempotencyKey(...args) {
                  historyReads++;
                  enter();
                  await pause;
                  return history.getByIdempotencyKey(...args);
                },
                async append(message) {
                  historyWrites++;
                  return history.append(message);
                },
              },
              socketManager: { broadcastToRoom() {} },
            });
    const calls = Array.from({ length: 30 }, () => sweep.runOnce());
    try {
      // The production cycle must reach its real storage port before the barrier is released.
      await entered;
      calls.push(sweep.runOnce());
      assert(
        calls.every((call) => call === calls[0]),
        `${kind}: overlapping callers share the same promise`,
      );
      assert.equal(scans, 1, `${kind}: one census while 30 timer firings overlap`);
      release();
      const values = await Promise.all(calls);
      assert(values.every((value) => value === values[0]));
      if (kind === 'managed') {
        assert.equal(historyReads, 1);
        assert.equal(historyWrites, 1);
        assert.equal(task.params.holdLifecycle.managedCommand.admissionFactAppended, true);
        const fact = await history.getByIdempotencyKey(
          principal.userId,
          principal.threadId,
          buildAdmissionFactIdempotencyKey(task.id),
        );
        assert.equal(fact.content, 'original admission');
      }
    } finally {
      release();
      await Promise.allSettled(calls);
    }
    await sweep.runOnce();
    assert.equal(scans, 2, `${kind}: next cycle is fresh`);
    if (kind === 'managed') assert.equal(historyWrites, 1, 'the next cycle does not repeat the admission fact');
  }
  let attempts = 0;
  const sweep = new ActionSuccessorRecoverySweep({
    leaseStore: {
      listPendingReturns: async () => {
        if (++attempts === 1) throw new Error('temporary');
        return [];
      },
    },
  });
  await assert.rejects(sweep.runOnce(), /temporary/);
  assert.equal((await sweep.runOnce()).scanned, 0);
});
test('ActionSuccessor timer coalesces all three owners until slow siblings settle after an early failure', async () => {
  const { createActionSuccessorRecoveryCycle } = await import(
    '../dist/domains/ball-custody/ActionSuccessorRecoveryCycle.js'
  );
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [0, 0, 0];
  let fail = true;
  const run = createActionSuccessorRecoveryCycle({
    recoverReturns: async () => {
      calls[0]++;
      if (fail) throw new Error('census unavailable');
      return { scanned: 0, delivered: 0, pending: 0, overdue: 0 };
    },
    recoverDispatches: async () => {
      calls[1]++;
      return { scanned: 0, delivered: 0, pending: 0, failed: 0 };
    },
    reconcileDoneTasks: async () => {
      calls[2]++;
      await slow;
      return { scanned: 0, attempted: 0, committed: 0, skipped: 0, errored: 0 };
    },
  });
  let settled = false;
  const first = run().catch((error) => {
    settled = true;
    return error;
  });
  await setImmediate();
  const queued = Array.from({ length: 30 }, () => run().catch((error) => error));
  await setImmediate();
  assert.equal(settled, false);
  assert.deepEqual(calls, [1, 1, 1]);
  release();
  assert((await first) instanceof AggregateError);
  assert(
    (await Promise.all(queued)).every((result) => result === undefined),
    'overlapping timer ticks produce no duplicate completion log',
  );
  fail = false;
  await run();
  assert.deepEqual(calls, [2, 2, 2]);
});
