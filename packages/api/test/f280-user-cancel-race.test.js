import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { WaitTerminationService } from '../dist/domains/ball-custody/WaitTerminationService.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { RunLedger } from '../dist/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../dist/infrastructure/scheduler/TaskRunnerV2.js';

const noManagedWake = {
  reserve: () => ({ outcome: 'not_found' }),
  commit: () => false,
  release: () => false,
  cancelIfTaskMatches: () => false,
};

function holdDef(id, fireAt) {
  return {
    id,
    templateId: 'reminder',
    trigger: { type: 'once', fireAt },
    params: { message: 'wait', targetCatId: 'codex-sol' },
    display: { label: 'wait', category: 'system', description: 'wait' },
    deliveryThreadId: 'thread-1',
    enabled: true,
    createdBy: 'hold-ball:codex-sol',
    createdAt: new Date().toISOString(),
  };
}

function onceSpec(id, fireAt, execute) {
  return {
    id,
    profile: 'awareness',
    trigger: { type: 'once', fireAt },
    admission: {
      gate: async () => ({ run: true, workItems: [{ signal: 'wake', subjectKey: 'thread-1' }] }),
    },
    run: { overlap: 'skip', timeoutMs: 5_000, execute },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
  };
}

async function registerScheduleRoutesForTest(app, db, options, ownerUserId = 'owner-1') {
  const { scheduleRoutes } = await import('../dist/routes/schedule.js');
  const { ScheduleMutationProposalStore } = await import(
    '../dist/infrastructure/scheduler/ScheduleMutationProposalStore.js'
  );
  app.decorateRequest('sessionUserId', undefined);
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = ownerUserId;
  });
  await app.register(scheduleRoutes, {
    ...options,
    ownerUserId,
    scheduleMutationProposalStore: new ScheduleMutationProposalStore(db),
    approvalIngress: {
      async publish(draft, store) {
        const envelope = {
          canonicalProposalId: draft.canonicalProposalId,
          sourceFeatureId: draft.producerId,
          ownerUserId: draft.ownerUserId,
          requesterCatId: draft.requesterCatId,
          originRef: draft.originRef,
          approvalCardRef: { threadId: draft.cardThreadId, messageId: `card-${draft.canonicalProposalId}` },
          createdAt: draft.createdAt,
        };
        store.commitEnvelope(draft.canonicalProposalId, envelope);
        return envelope;
      },
    },
  });
}

test('an applied user cancel fences a due one-shot while durable commit is in flight', async () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const dynamicTaskStore = new DynamicTaskStore(db);
  const ledger = new RunLedger(db);
  const waitId = 'hold-ball-cancel-wins';
  const fireAt = Date.now() + 40;
  dynamicTaskStore.insert(holdDef(waitId, fireAt));

  let wakeCount = 0;
  const runner = new TaskRunnerV2({
    logger: { info() {}, error() {} },
    ledger,
    dynamicTaskStore,
  });
  runner.registerDynamic(
    onceSpec(waitId, fireAt, async () => {
      wakeCount += 1;
    }),
    waitId,
  );

  let markCommitStarted;
  const commitStarted = new Promise((resolve) => {
    markCommitStarted = resolve;
  });
  let releaseCommit;
  const commitMayFinish = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  const records = new Map();
  const service = new WaitTerminationService({
    store: {
      getByWaitId: async (id) => records.get(id) ?? null,
      commit: async (record) => {
        markCommitStarted();
        await commitMayFinish;
        records.set(record.event.waitId, record);
        return 'applied';
      },
      loadEntry: async () => null,
      listRecords: async () => [...records.values()],
    },
    dynamicTaskStore,
    taskRunner: runner,
    managedWakeCancellation: noManagedWake,
    threadStore: { get: () => ({ createdBy: 'owner-1' }) },
    now: () => 789,
  });

  runner.start();
  const cancellation = service.cancelByUser({ waitId, ownerUserId: 'owner-1' });
  await commitStarted;
  await new Promise((resolve) => setTimeout(resolve, 80));
  const wakeCountBeforeCommit = wakeCount;
  releaseCommit();
  const result = await cancellation;
  await new Promise((resolve) => setTimeout(resolve, 20));
  runner.stop();
  db.close();

  assert.equal(result.outcome, 'applied');
  assert.equal(wakeCountBeforeCommit, 0, 'a reserved cancellation must suppress a timer that becomes due');
  assert.equal(wakeCount, 0, 'an applied cancellation must never emit the wait wake');
  assert.equal(records.get(waitId)?.event.reason, 'user_cancel');
});

test('a failed durable commit releases the fence and re-arms a timer that became due', async () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const dynamicTaskStore = new DynamicTaskStore(db);
  const ledger = new RunLedger(db);
  const waitId = 'hold-ball-cancel-rollback';
  const fireAt = Date.now() + 40;
  dynamicTaskStore.insert(holdDef(waitId, fireAt));

  let wakeCount = 0;
  const runner = new TaskRunnerV2({
    logger: { info() {}, error() {} },
    ledger,
    dynamicTaskStore,
  });
  runner.registerDynamic(
    onceSpec(waitId, fireAt, async () => {
      wakeCount += 1;
    }),
    waitId,
  );

  let markCommitStarted;
  const commitStarted = new Promise((resolve) => {
    markCommitStarted = resolve;
  });
  let releaseCommit;
  const commitMayFail = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  const service = new WaitTerminationService({
    store: {
      getByWaitId: async () => null,
      commit: async () => {
        markCommitStarted();
        await commitMayFail;
        throw new Error('redis unavailable');
      },
      loadEntry: async () => null,
      listRecords: async () => [],
    },
    dynamicTaskStore,
    taskRunner: runner,
    managedWakeCancellation: noManagedWake,
    threadStore: { get: () => ({ createdBy: 'owner-1' }) },
  });

  runner.start();
  const cancellation = service.cancelByUser({ waitId, ownerUserId: 'owner-1' });
  await commitStarted;
  await new Promise((resolve) => setTimeout(resolve, 80));
  const wakeCountBeforeFailure = wakeCount;
  releaseCommit();
  await assert.rejects(cancellation, /redis unavailable/);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const wakeCountAfterRelease = wakeCount;
  runner.stop();
  db.close();

  assert.equal(wakeCountBeforeFailure, 0, 'the due timer remains fenced while commit outcome is unknown');
  assert.equal(wakeCountAfterRelease, 1, 'a proven-uncommitted cancellation must restore the original wake');
});

test('the real schedule trigger route cannot enter a one-shot while user cancellation is committing', async () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const dynamicTaskStore = new DynamicTaskStore(db);
  const ledger = new RunLedger(db);
  const waitId = 'hold-ball-manual-trigger-race';
  const fireAt = Date.now() + 60_000;
  dynamicTaskStore.insert(holdDef(waitId, fireAt));

  let wakeCount = 0;
  const runner = new TaskRunnerV2({
    logger: { info() {}, error() {} },
    ledger,
    dynamicTaskStore,
  });
  runner.registerDynamic(
    onceSpec(waitId, fireAt, async () => {
      wakeCount += 1;
    }),
    waitId,
  );

  let markCommitStarted;
  const commitStarted = new Promise((resolve) => {
    markCommitStarted = resolve;
  });
  let releaseCommit;
  const commitMayFinish = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  const records = new Map();
  const service = new WaitTerminationService({
    store: {
      getByWaitId: async (id) => records.get(id) ?? null,
      commit: async (record) => {
        markCommitStarted();
        await commitMayFinish;
        records.set(record.event.waitId, record);
        return 'applied';
      },
      loadEntry: async () => null,
      listRecords: async () => [...records.values()],
    },
    dynamicTaskStore,
    taskRunner: runner,
    managedWakeCancellation: noManagedWake,
    threadStore: { get: () => ({ createdBy: 'owner-1' }) },
  });

  const app = Fastify({ logger: false });
  await registerScheduleRoutesForTest(app, db, { taskRunner: runner, dynamicTaskStore });
  await app.ready();

  const cancellation = service.cancelByUser({ waitId, ownerUserId: 'owner-1' });
  await commitStarted;
  const trigger = await app.inject({ method: 'POST', url: `/api/schedule/tasks/${waitId}/trigger` });
  releaseCommit();
  const cancelResult = await cancellation;

  await app.close();
  db.close();

  assert.equal(cancelResult.outcome, 'applied');
  assert.equal(trigger.statusCode, 409, 'manual execution must report cancellation admission conflict');
  assert.equal(wakeCount, 0, 'an applied cancellation must fence the real manual trigger route');
});
