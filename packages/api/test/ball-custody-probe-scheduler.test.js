/**
 * F233 PR4 — ProbeScheduler / WakeSender behavior.
 *
 * The projector remains side-effect free. Wake delivery happens only in the realtime
 * scheduler tick path, and the accepted ball.wake_sent event records the delivered wake.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function makeProjection(overrides = {}) {
  return {
    subjectKey: 'ball:task:t1',
    state: 'blocked',
    holder: null,
    intent: null,
    resolveMode: 'bounces_back',
    heldUntil: null,
    blockedSinceAt: 1_000,
    lastWakeAt: null,
    lastScanAt: null,
    lastStateChangeAt: 1_000,
    lastEventAt: 1_000,
    appliedEventCount: 1,
    lastRejectedEvent: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function memoryProjectionStore() {
  const entries = new Map();
  return {
    async get(subjectKey) {
      return entries.has(subjectKey) ? structuredClone(entries.get(subjectKey)) : null;
    },
    async save(projection) {
      entries.set(projection.subjectKey, structuredClone(projection));
    },
    async listSubjectKeys() {
      return [...entries.keys()];
    },
    async delete(subjectKey) {
      entries.delete(subjectKey);
    },
  };
}

async function setupTask({ resolveMode = 'bounces_back' } = {}) {
  const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
  const taskStore = new TaskStore();
  const task = taskStore.create({
    threadId: 'thread-1',
    title: 'Wait for deploy',
    why: 'Probe should resolve once deploy is live',
    createdBy: 'codex',
    ownerCatId: 'codex',
    probe: { kind: 'redis_exists', key: 'probe:ready' },
    resolveMode,
  });
  taskStore.update(task.id, { status: 'blocked' });
  return { taskStore, taskId: task.id };
}

function schedulerDeps({ taskStore, projectionStore, now = 5_000, satisfied = true, record } = {}) {
  const events = [];
  const wakeCalls = [];
  const nowFn = typeof now === 'function' ? now : () => now;
  return {
    deps: {
      taskStore,
      projectionStore,
      ballCustody: {
        async record(event) {
          if (record) return record(event);
          events.push(event);
        },
      },
      probeEvaluator: {
        async evaluate() {
          return { satisfied };
        },
      },
      wakeSender: {
        async send(input) {
          wakeCalls.push(input);
          return { messageId: 'msg-wake-1' };
        },
      },
      now: nowFn,
      wakeCooldownMs: 60_000,
      idleLongMs: 60_000,
      logger: { warn() {}, error() {}, info() {} },
    },
    events,
    wakeCalls,
  };
}

describe('BallCustodyProbeScheduler', () => {
  it('bounces_back: sends a real wake before recording ball.wake_sent', async () => {
    const { BallCustodyProbeScheduler } = await import('../dist/domains/ball-custody/BallCustodyProbeScheduler.js');
    const { taskStore, taskId } = await setupTask({ resolveMode: 'bounces_back' });
    const projectionStore = memoryProjectionStore();
    await projectionStore.save(makeProjection({ subjectKey: `ball:task:${taskId}` }));
    const { deps, events, wakeCalls } = schedulerDeps({ taskStore, projectionStore });

    const result = await new BallCustodyProbeScheduler(deps).tick();

    assert.equal(result.checked, 1);
    assert.equal(result.woken, 1);
    assert.equal(wakeCalls.length, 1);
    assert.equal(wakeCalls[0].task.id, taskId);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'ball.wake_sent');
    assert.equal(events[0].sourceEventId, `wake:${taskId}:1000:5000`);
  });

  it('completes: marks task done without sending wake', async () => {
    const { BallCustodyProbeScheduler } = await import('../dist/domains/ball-custody/BallCustodyProbeScheduler.js');
    const { taskStore, taskId } = await setupTask({ resolveMode: 'completes' });
    const projectionStore = memoryProjectionStore();
    await projectionStore.save(makeProjection({ subjectKey: `ball:task:${taskId}`, resolveMode: 'completes' }));
    const { deps, events, wakeCalls } = schedulerDeps({ taskStore, projectionStore });

    const result = await new BallCustodyProbeScheduler(deps).tick();

    assert.equal(result.completed, 1);
    assert.equal(taskStore.get(taskId).status, 'done');
    assert.equal(wakeCalls.length, 0);
    assert.equal(events.length, 0);
  });

  it('uses current task resolveMode when projection is stale', async () => {
    const { BallCustodyProbeScheduler } = await import('../dist/domains/ball-custody/BallCustodyProbeScheduler.js');
    const { taskStore, taskId } = await setupTask({ resolveMode: 'bounces_back' });
    taskStore.update(taskId, { resolveMode: 'completes' });
    const projectionStore = memoryProjectionStore();
    await projectionStore.save(makeProjection({ subjectKey: `ball:task:${taskId}`, resolveMode: 'bounces_back' }));
    const { deps, events, wakeCalls } = schedulerDeps({ taskStore, projectionStore });

    const result = await new BallCustodyProbeScheduler(deps).tick();

    assert.equal(result.completed, 1);
    assert.equal(taskStore.get(taskId).status, 'done');
    assert.equal(wakeCalls.length, 0);
    assert.equal(events.length, 0);
  });

  it('honors clearing task resolveMode even when projection is stale', async () => {
    const { BallCustodyProbeScheduler } = await import('../dist/domains/ball-custody/BallCustodyProbeScheduler.js');
    const { taskStore, taskId } = await setupTask({ resolveMode: 'bounces_back' });
    taskStore.update(taskId, { resolveMode: null });
    const projectionStore = memoryProjectionStore();
    await projectionStore.save(makeProjection({ subjectKey: `ball:task:${taskId}`, resolveMode: 'bounces_back' }));
    const { deps, events, wakeCalls } = schedulerDeps({ taskStore, projectionStore });

    const result = await new BallCustodyProbeScheduler(deps).tick();

    assert.equal(result.skipped, 1);
    assert.equal(result.checked, 0);
    assert.equal(wakeCalls.length, 0);
    assert.equal(events.length, 0);
  });

  it('bounces_back: respects lastWakeAt cooldown so rebuild/replay cannot re-deliver', async () => {
    const { BallCustodyProbeScheduler } = await import('../dist/domains/ball-custody/BallCustodyProbeScheduler.js');
    const { taskStore, taskId } = await setupTask({ resolveMode: 'bounces_back' });
    const projectionStore = memoryProjectionStore();
    await projectionStore.save(makeProjection({ subjectKey: `ball:task:${taskId}`, lastWakeAt: 4_500 }));
    const { deps, events, wakeCalls } = schedulerDeps({ taskStore, projectionStore, now: 5_000 });

    const result = await new BallCustodyProbeScheduler(deps).tick();

    assert.equal(result.cooldownSkipped, 1);
    assert.equal(wakeCalls.length, 0);
    assert.equal(events.length, 0);
  });

  it('bounces_back: send success plus wake_sent record failure still suppresses repeat wakes in-process', async () => {
    const { BallCustodyProbeScheduler } = await import('../dist/domains/ball-custody/BallCustodyProbeScheduler.js');
    const { taskStore, taskId } = await setupTask({ resolveMode: 'bounces_back' });
    const projectionStore = memoryProjectionStore();
    await projectionStore.save(makeProjection({ subjectKey: `ball:task:${taskId}` }));
    let now = 5_000;
    const recordErrors = [];
    const { deps, wakeCalls } = schedulerDeps({
      taskStore,
      projectionStore,
      now: () => now,
      record: async () => {
        recordErrors.push(new Error('event log down'));
        throw recordErrors[recordErrors.length - 1];
      },
    });
    const scheduler = new BallCustodyProbeScheduler(deps);

    const first = await scheduler.tick();
    now = 6_000;
    const second = await scheduler.tick();

    assert.equal(first.woken, 1, 'first tick delivered the real wake');
    assert.equal(first.failed, 1, 'record failure remains visible');
    assert.equal(second.cooldownSkipped, 1, 'second tick suppresses repeat delivery during cooldown');
    assert.equal(wakeCalls.length, 1, 'owner is not repeatedly woken while wake_sent recording is down');
    assert.equal(recordErrors.length, 1, 'cooldown skip avoids another doomed wake_sent write');
  });

  it('marks long-idle task projections as task.idle_long', async () => {
    const { BallCustodyProbeScheduler } = await import('../dist/domains/ball-custody/BallCustodyProbeScheduler.js');
    const { taskStore, taskId } = await setupTask({ resolveMode: 'bounces_back' });
    const projectionStore = memoryProjectionStore();
    await projectionStore.save(
      makeProjection({
        subjectKey: `ball:task:${taskId}`,
        state: 'active',
        lastEventAt: 1_000,
        lastStateChangeAt: 1_000,
      }),
    );
    const { deps, events, wakeCalls } = schedulerDeps({ taskStore, projectionStore, now: 62_000 });

    const result = await new BallCustodyProbeScheduler(deps).tick();

    assert.equal(result.idleMarked, 1);
    assert.equal(wakeCalls.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.idle_long');
    assert.equal(events[0].sourceEventId, `task:${taskId}:idle:62000`);
  });
});
