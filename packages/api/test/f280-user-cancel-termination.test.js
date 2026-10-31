import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { WaitTerminationService } from '../dist/domains/ball-custody/WaitTerminationService.js';
import { buildWaitCancellationDispositionLedgerEntry } from '../dist/domains/human-disposition/human-disposition-adapters.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { RunLedger } from '../dist/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../dist/infrastructure/scheduler/TaskRunnerV2.js';
import { registerWaitTerminationRoutes } from '../dist/routes/wait-termination-routes.js';

function holdTask() {
  return {
    id: 'hold-ball-123',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: Date.now() + 60_000 },
    params: { message: 'wait', targetCatId: 'codex-sol' },
    display: { label: 'wait', category: 'system', description: 'wait' },
    deliveryThreadId: 'thread-1',
    enabled: true,
    createdBy: 'hold-ball:codex-sol',
    createdAt: new Date().toISOString(),
  };
}

function noManagedWake() {
  return {
    reserve: () => ({ outcome: 'not_found' }),
    commit: () => false,
    release: () => false,
    cancelIfTaskMatches: () => false,
  };
}

function harness(taskRunnerOverrides = {}, managedWakeCancellation = noManagedWake()) {
  const records = new Map();
  const tasks = new Map([['hold-ball-123', holdTask()]]);
  const trace = [];
  const store = {
    async getByWaitId(waitId) {
      return records.get(waitId) ?? null;
    },
    async commit(record) {
      trace.push('commit');
      const existing = records.get(record.event.waitId);
      if (!existing) {
        records.set(record.event.waitId, record);
        return 'applied';
      }
      return JSON.stringify(existing) === JSON.stringify(record) ? 'replay' : 'conflict';
    },
    async loadEntry({ ownerUserId, receipt }) {
      const record = [...records.values()].find(
        (candidate) =>
          candidate.event.ownerUserId === ownerUserId && candidate.entry.episode.sourceRef === receipt.sourceRef,
      );
      return record?.entry ?? null;
    },
  };
  const service = new WaitTerminationService({
    store,
    dynamicTaskStore: {
      getById(id) {
        return tasks.get(id) ?? null;
      },
      remove(id) {
        trace.push('remove');
        return tasks.delete(id);
      },
    },
    taskRunner: {
      reserveOnceCancellation() {
        return { outcome: 'reserved', token: 1 };
      },
      releaseOnceCancellation() {
        return true;
      },
      unregister(id) {
        trace.push(`unregister:${id}`);
      },
      ...taskRunnerOverrides,
    },
    threadStore: {
      async get(threadId) {
        return threadId === 'thread-1' ? { createdBy: 'owner-1' } : null;
      },
    },
    managedWakeCancellation,
    now: () => 123,
  });
  return { service, store, records, tasks, trace };
}

describe('F280 canonical user-cancel termination', () => {
  test('F281 adapter binds why to the canonical event without changing termination truth', () => {
    const event = {
      v: 1,
      eventId: 'wait-termination:hold_ball:hold-ball-123:user_cancel',
      kind: 'wait.terminated',
      waitId: 'hold-ball-123',
      waitKind: 'hold_ball',
      generation: 1,
      subjectRef: 'wait:hold_ball:hold-ball-123',
      threadId: 'thread-1',
      ownerUserId: 'owner-1',
      ownerCatId: 'codex-sol',
      reason: 'user_cancel',
      actor: { kind: 'user', userId: 'owner-1' },
      at: 123,
    };
    const entry = buildWaitCancellationDispositionLedgerEntry({
      event,
      feedback: { reasonCode: 'other', detail: 'I am taking a different path' },
    });

    assert.equal(entry.episode.interactionKind, 'wait_cancel');
    assert.equal(entry.episode.subjectRef, event.subjectRef);
    assert.equal(entry.episode.decision, 'cancelled');
    assert.equal(entry.episode.ownerUserId, 'owner-1');
    assert.equal(entry.episode.producerCatId, 'codex-sol');
    assert.equal(entry.episode.sourceRef, event.eventId);
    assert.deepEqual(entry.envelope.feedback, {
      reasonCode: 'other',
      detail: 'I am taking a different path',
    });
    assert.equal(Object.hasOwn(event, 'feedback'), false);
  });

  test('commits canonical truth before removing the execution projection', async () => {
    const { service, trace, tasks } = harness();
    const result = await service.cancelByUser({
      waitId: 'hold-ball-123',
      ownerUserId: 'owner-1',
      feedback: { reasonCode: 'wrong_lane' },
    });

    assert.equal(result.outcome, 'applied');
    assert.deepEqual(trace, ['commit', 'unregister:hold-ball-123', 'remove']);
    assert.equal(tasks.has('hold-ball-123'), false);
  });

  test('replays byte-identical feedback and conflicts on changed feedback after projection removal', async () => {
    const { service } = harness();
    const first = await service.cancelByUser({
      waitId: 'hold-ball-123',
      ownerUserId: 'owner-1',
      feedback: { reasonCode: 'wrong' },
    });
    const replay = await service.cancelByUser({
      waitId: 'hold-ball-123',
      ownerUserId: 'owner-1',
      feedback: { reasonCode: 'wrong' },
    });
    const conflict = await service.cancelByUser({
      waitId: 'hold-ball-123',
      ownerUserId: 'owner-1',
      feedback: { reasonCode: 'not_now' },
    });

    assert.equal(first.outcome, 'applied');
    assert.equal(replay.outcome, 'replay');
    assert.equal(conflict.outcome, 'conflict');
  });

  test('rejects a different owner without committing or touching the projection', async () => {
    const { service, records, tasks } = harness();
    const result = await service.cancelByUser({
      waitId: 'hold-ball-123',
      ownerUserId: 'intruder',
      feedback: { reasonCode: 'wrong' },
    });

    assert.equal(result.outcome, 'forbidden');
    assert.equal(records.size, 0);
    assert.equal(tasks.has('hold-ball-123'), true);
  });

  test('does not remove the execution projection when canonical persistence fails', async () => {
    const { service, store, tasks, trace } = harness();
    store.commit = async () => {
      trace.push('commit');
      throw new Error('redis unavailable');
    };

    await assert.rejects(
      service.cancelByUser({ waitId: 'hold-ball-123', ownerUserId: 'owner-1' }),
      /redis unavailable/,
    );
    assert.deepEqual(trace, ['commit']);
    assert.equal(tasks.has('hold-ball-123'), true);
  });

  test('refuses canonical user_cancel after the one-shot execution pipeline has entered run.execute', async () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const dynamicTaskStore = new DynamicTaskStore(db);
    const ledger = new RunLedger(db);
    const task = {
      ...holdTask(),
      id: 'hold-ball-entered',
      trigger: { type: 'once', fireAt: Date.now() + 25 },
    };
    dynamicTaskStore.insert(task);

    let markExecutionStarted;
    const executionStarted = new Promise((resolve) => {
      markExecutionStarted = resolve;
    });
    let finishExecution;
    const executionMayFinish = new Promise((resolve) => {
      finishExecution = resolve;
    });
    const runner = new TaskRunnerV2({
      logger: { info() {}, error() {} },
      ledger,
      dynamicTaskStore,
    });
    runner.registerDynamic(
      {
        id: task.id,
        profile: 'awareness',
        trigger: task.trigger,
        admission: {
          gate: async () => ({ run: true, workItems: [{ signal: 'wake', subjectKey: 'thread-1' }] }),
        },
        run: {
          overlap: 'skip',
          timeoutMs: 5_000,
          execute: async () => {
            markExecutionStarted();
            await executionMayFinish;
          },
        },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'drop' },
        enabled: () => true,
      },
      task.id,
    );
    const records = new Map();
    const service = new WaitTerminationService({
      store: {
        getByWaitId: async (waitId) => records.get(waitId) ?? null,
        commit: async (record) => {
          records.set(record.event.waitId, record);
          return 'applied';
        },
        loadEntry: async () => null,
        listRecords: async () => [...records.values()],
      },
      dynamicTaskStore,
      taskRunner: runner,
      managedWakeCancellation: noManagedWake(),
      threadStore: { get: () => ({ createdBy: 'owner-1' }) },
      now: () => 456,
    });

    runner.start();
    await executionStarted;
    const result = await service.cancelByUser({
      waitId: task.id,
      ownerUserId: 'owner-1',
      feedback: { reasonCode: 'not_now' },
    });
    const projectionStillExists = dynamicTaskStore.getById(task.id) !== null;

    finishExecution();
    await new Promise((resolve) => setTimeout(resolve, 20));
    runner.stop();
    db.close();

    assert.equal(result.outcome, 'execution_started');
    assert.equal(records.size, 0, 'an entered wake must not coexist with durable user_cancel truth');
    assert.equal(projectionStillExists, true);
  });

  test('route exposes an entered one-shot as a non-terminal 409 without an event', async () => {
    const { service, records } = harness({
      reserveOnceCancellation: () => ({ outcome: 'execution_started' }),
    });
    const app = Fastify();
    registerWaitTerminationRoutes(app, { service });

    const response = await app.inject({
      method: 'POST',
      url: '/api/waits/hold-ball/hold-ball-123/cancel',
      headers: { 'x-cat-cafe-user': 'owner-1' },
      payload: {},
    });

    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), { error: 'wait_execution_started' });
    assert.equal(records.size, 0);
  });

  test('releases the one-shot reservation when managed-command delivery already started', async () => {
    const trace = [];
    const { service, records, tasks } = harness(
      {
        releaseOnceCancellation(id, token) {
          trace.push(`release-once:${id}:${token}`);
          return true;
        },
      },
      {
        reserve() {
          return { outcome: 'execution_started' };
        },
        commit() {
          throw new Error('must not commit managed cancellation');
        },
        release() {
          throw new Error('no managed token exists');
        },
        cancelIfTaskMatches() {
          throw new Error('must not clean an entered wake');
        },
      },
    );

    const result = await service.cancelByUser({ waitId: 'hold-ball-123', ownerUserId: 'owner-1' });

    assert.equal(result.outcome, 'execution_started');
    assert.deepEqual(trace, ['release-once:hold-ball-123:1']);
    assert.equal(records.size, 0);
    assert.equal(tasks.has('hold-ball-123'), true);
  });

  test('commits both runtime reservations only after durable user_cancel exists', async () => {
    const managedTrace = [];
    const managedWakeCancellation = {
      reserve(waitId) {
        managedTrace.push(`managed-reserve:${waitId}`);
        return { outcome: 'reserved', token: 9 };
      },
      commit(waitId, _threadId, _catId, token) {
        managedTrace.push(`managed-commit:${waitId}:${token}`);
        return true;
      },
      release() {
        throw new Error('successful persistence must not release the reservation');
      },
      cancelIfTaskMatches() {
        throw new Error('token-bound cleanup must use commit');
      },
    };
    const { service, trace } = harness({}, managedWakeCancellation);

    const result = await service.cancelByUser({ waitId: 'hold-ball-123', ownerUserId: 'owner-1' });

    assert.equal(result.outcome, 'applied');
    assert.deepEqual(managedTrace, ['managed-reserve:hold-ball-123', 'managed-commit:hold-ball-123:9']);
    assert.deepEqual(trace, ['commit', 'unregister:hold-ball-123', 'remove']);
  });

  test('new route is strict, owner-authenticated, and does not patch the legacy callback API', async () => {
    const { service } = harness();
    const app = Fastify();
    registerWaitTerminationRoutes(app, { service });

    const forged = await app.inject({
      method: 'POST',
      url: '/api/waits/hold-ball/hold-ball-123/cancel',
      headers: { 'x-cat-cafe-user': 'owner-1' },
      payload: { ownerUserId: 'owner-1', feedback: { reasonCode: 'wrong' } },
    });
    assert.equal(forged.statusCode, 400);

    const applied = await app.inject({
      method: 'POST',
      url: '/api/waits/hold-ball/hold-ball-123/cancel',
      headers: { 'x-cat-cafe-user': 'owner-1' },
      payload: { feedback: { reasonCode: 'wrong' } },
    });
    assert.equal(applied.statusCode, 200);
    assert.equal(applied.json().event.reason, 'user_cancel');
    assert.equal(Object.hasOwn(applied.json().event, 'feedback'), false);

    const legacy = await app.inject({
      method: 'DELETE',
      url: '/api/callbacks/hold-ball/hold-ball-123',
      headers: { 'x-cat-cafe-user': 'owner-1' },
    });
    assert.equal(legacy.statusCode, 404);
  });
});
