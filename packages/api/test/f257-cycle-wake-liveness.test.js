// F257: a writeback clock measures the time an evaluator had to answer, so it
// starts at the exact moment the wake's body reached a provider invocation — the
// durable, append-only exposure on the wake message's Queue custody.
// Production 2026-09-15 (S13): the only retrigger was enqueued behind a silent
// evaluator invocation at 11:54, the second 30-minute window ran anyway, and the
// cycle was declared stalled at 12:35 — 58 minutes before the retrigger even ran.
// Review 2026-09-18: "no longer queued" is not delivery either. The queue moves
// queued → processing → queued when a start fails, and forgets its rows on restart.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  catalog,
  FakeRedis,
  FakeThreadStore,
  FakeWakeQueue,
  principal,
  submission,
  trace,
} from './f257-stalled-cycle-fixture.js';

const { CycleEvaluationCoordinator, CYCLE_WRITEBACK_TIMEOUT_MS: T } = await import(
  '../dist/infrastructure/harness-eval/evaluation/CycleEvaluationCoordinator.js'
);
const { CycleRecordStore } = await import('../dist/infrastructure/harness-eval/evaluation/CycleRecordStore.js');

/** One API process: everything it holds in memory is rebuilt, only Redis and the stored messages are shared. */
function processOver(redis, wakes, clock) {
  const cycles = new CycleRecordStore(redis);
  const traces = [trace('inv-1', 500)];
  const coordinator = new CycleEvaluationCoordinator({
    runtime: {
      catalog,
      cycles,
      annotations: {
        async queryMetricWindow() {
          return [];
        },
      },
      traces: {
        async ownerInvocationIds() {
          return traces.map((episode) => episode.terminal.invocationId);
        },
        async getEpisodeByInvocationId(id) {
          return traces.find((e) => e.terminal.invocationId === id) ?? null;
        },
      },
      cycleChecker: { setRequestedHandler() {} },
    },
    threadStore: new FakeThreadStore(),
    messageStore: wakes.messageStore,
    deliver: wakes.deliver,
    getInvokeTrigger: () => wakes.invokeTrigger,
    getDefaultCatId: () => 'cat-default',
    now: () => clock.now,
  });
  return { cycles, coordinator };
}

/** A requested cycle on an evaluation thread whose queue never starts a wake unless the test says so. */
async function harness() {
  const redis = new FakeRedis();
  const clock = { now: 100 };
  const wakes = new FakeWakeQueue({ clock, autoDeliver: false });
  const { cycles, coordinator } = processOver(redis, wakes, clock);
  const idle = await cycles.initialize('owner-1', 'obj', 0, { version: 'v1', versionContentRef: 'hooks:D1@1' });
  const requested = { ...idle, cycleEnd: 1_000, evalStatus: 'requested', windows: [{ start: 0, end: 1_000 }] };
  assert.equal(await cycles.request(idle, requested), true);
  return {
    wakes,
    coordinator,
    current: () => cycles.current('owner-1', 'obj'),
    restart: () => processOver(redis, wakes, clock).coordinator,
  };
}

/** requested → assignment delivered at 150 → retriggered at 150 + T, the retrigger still waiting in the queue. */
async function queuedRetrigger() {
  const h = await harness();
  await h.coordinator.reconcileKnownCycles(100);
  h.wakes.expose((await h.current()).assignmentMessageId, 150);
  await h.coordinator.reconcileKnownCycles(200);
  await h.coordinator.reconcileKnownCycles(150 + T);
  const retriggered = await h.current();
  assert.equal(retriggered.evalStatus, 'retriggered');
  assert.equal(retriggered.pendingWakeMessageId, retriggered.retriggerMessageId, 'the retrigger awaits its receipt');
  return { ...h, retriggered };
}

describe('F257 cycle wake liveness: only an exact delivery receipt starts a writeback clock', () => {
  test('every wake is stored queued and force-queued, so the Queue keeps durable custody of it', async () => {
    const h = await harness();
    await h.coordinator.reconcileKnownCycles(100);
    assert.equal(h.wakes.deliveries[0].deliveryStatus, 'queued');
    assert.equal(h.wakes.triggers[0].policy?.forceQueue, true);
    const assigned = await h.current();
    assert.equal(assigned.pendingWakeMessageId, assigned.assignmentMessageId, 'sent is not delivered');
  });

  test('the clock starts at the exact first exposure, not at the tick that noticed it', async () => {
    const h = await harness();
    await h.coordinator.reconcileKnownCycles(100);
    const { assignmentMessageId } = await h.current();
    h.wakes.expose(assignmentMessageId, 150);
    h.wakes.expose(assignmentMessageId, 900, 'a-retry-after-a-crash');
    await h.coordinator.reconcileKnownCycles(40_000);
    const running = await h.current();
    assert.equal(running.assignedAt, 150);
    assert.equal(running.pendingWakeMessageId, undefined);
  });

  test('an assignment reserved and rolled back by a failed start has not reached the evaluator', async () => {
    const h = await harness();
    await h.coordinator.reconcileKnownCycles(100);
    const assigned = await h.current();
    const wake = assigned.assignmentMessageId;

    h.wakes.reserve(wake); // queued → processing; reconciliation lands inside this window
    await h.coordinator.reconcileKnownCycles(assigned.assignedAt + 10);
    assert.equal((await h.current()).pendingWakeMessageId, wake, 'processing is not a delivery receipt');
    h.wakes.rollback(wake); // the start failed: processing → queued

    await h.coordinator.reconcileKnownCycles(assigned.assignedAt + T);
    await h.coordinator.reconcileKnownCycles(assigned.assignedAt + 4 * T);
    assert.equal(
      h.wakes.count('Retrigger'),
      0,
      'a wake waiting again after a failed start has not reached the evaluator',
    );
    assert.equal((await h.current()).evalStatus, 'requested');

    const deliveredAt = assigned.assignedAt + 5 * T;
    h.wakes.expose(wake, deliveredAt);
    await h.coordinator.reconcileKnownCycles(deliveredAt + 1_000);
    assert.equal((await h.current()).assignedAt, deliveredAt);
    await h.coordinator.reconcileKnownCycles(deliveredAt + T - 1);
    assert.equal(h.wakes.count('Retrigger'), 0);
    await h.coordinator.reconcileKnownCycles(deliveredAt + T);
    assert.equal(h.wakes.count('Retrigger'), 1);
    assert.equal((await h.current()).evalStatus, 'retriggered');
  });

  test('a retrigger queued behind a running invocation cannot stall the cycle, through a failed start or not', async () => {
    const { coordinator, wakes, current, retriggered } = await queuedRetrigger();
    const wake = retriggered.retriggerMessageId;

    // The original invocation stays active for hours: the retrigger never got its turn.
    await coordinator.reconcileKnownCycles(retriggered.retriggeredAt + T);
    await coordinator.reconcileKnownCycles(retriggered.retriggeredAt + 5 * T);
    wakes.reserve(wake);
    await coordinator.reconcileKnownCycles(retriggered.retriggeredAt + 5 * T + 1);
    wakes.rollback(wake);
    await coordinator.reconcileKnownCycles(retriggered.retriggeredAt + 7 * T);
    assert.deepEqual(await current(), retriggered, 'nothing moved: a queued retrigger is not a failed retrigger');
    assert.equal(wakes.count('Stalled'), 0);

    const deliveredAt = retriggered.retriggeredAt + 8 * T;
    wakes.expose(wake, deliveredAt);
    await coordinator.reconcileKnownCycles(deliveredAt + 40_000);
    const running = await current();
    assert.equal(running.evalStatus, 'retriggered');
    assert.equal(running.pendingWakeMessageId, undefined);
    assert.equal(running.retriggeredAt, deliveredAt, 'the second window starts when the evaluator got the wake');

    await coordinator.reconcileKnownCycles(deliveredAt + T - 1);
    assert.equal((await current()).evalStatus, 'retriggered');
    await coordinator.reconcileKnownCycles(deliveredAt + T);
    await coordinator.reconcileKnownCycles(deliveredAt + 3 * T);
    assert.equal((await current()).evalStatus, 'stalled');
    assert.equal(wakes.count('Stalled'), 1, 'exactly one stall alert');
    assert.equal(wakes.count('Retrigger'), 1, 'exactly one retrigger');
  });

  test('a writeback that lands first wins, and the late receipt changes nothing', async () => {
    const { coordinator, wakes, current, retriggered } = await queuedRetrigger();

    // The original, slow invocation finally writes back.
    const result = await coordinator.submitEvaluation(principal, { ...submission, cycleId: retriggered.cycleId });
    assert.equal(result.outcome, 'written');
    const written = await current();
    assert.equal(written.evalStatus, 'written');
    assert.equal(written.pendingWakeMessageId, undefined, 'a written cycle has no pending wake');

    wakes.expose(retriggered.retriggerMessageId, retriggered.retriggeredAt + 9 * T);
    await coordinator.reconcileKnownCycles(retriggered.retriggeredAt + 10 * T);
    assert.deepEqual(await current(), written);
    assert.equal(wakes.count('Stalled'), 0);
  });

  test('a restarted process reaches the same judgment from durable truth alone', async () => {
    const h = await harness();
    await h.coordinator.reconcileKnownCycles(100);
    const assigned = await h.current();

    // Restart while the wake still waits: nothing in memory survives, the wake is still undelivered.
    await h.restart().reconcileKnownCycles(assigned.assignedAt + 4 * T);
    assert.deepEqual(await h.current(), assigned);
    assert.equal(h.wakes.count('Retrigger'), 0);

    const deliveredAt = assigned.assignedAt + 5 * T;
    h.wakes.expose(assigned.assignmentMessageId, deliveredAt);
    await h.restart().reconcileKnownCycles(deliveredAt + 5_000);
    const running = await h.current();
    assert.equal(running.assignedAt, deliveredAt, 'the receipt time, however late a process observes it');
    await h.restart().reconcileKnownCycles(deliveredAt + 9_000);
    assert.deepEqual(await h.current(), running, 'observing it again restamps nothing');
  });

  test('a late duplicate assignment after delivery admits nothing and changes nothing', async () => {
    const h = await harness();
    const requested = await h.current();
    await h.coordinator.reconcileKnownCycles(100);
    const wake = (await h.current()).assignmentMessageId;
    h.wakes.expose(wake, 150);
    h.wakes.complete(wake); // the evaluator's invocation already finished
    await h.coordinator.reconcileKnownCycles(200);
    const running = await h.current();

    await h.coordinator.ensureAssignment(requested); // a stale caller arrives late with the pre-assignment record
    assert.deepEqual(await h.current(), running);
    assert.equal(h.wakes.triggers.length, 1, 'a delivered source is never re-admitted to the Queue');
    assert.deepEqual(h.wakes.poisonRows, []);
  });

  test('a delivery whose cycle CAS never landed is replayed after restart without a second admission', async () => {
    const h = await harness();
    const requested = await h.current();
    const crashed = h.coordinator.ensureObjectiveThread('obj', 'owner-1');
    const thread = await crashed;
    // The process delivered the wake and died before recording it on the cycle.
    const wake = await h.coordinator.deliverAndWake(requested, thread.threadId, thread.catId, 'x', 'assignment');
    h.wakes.expose(wake, 150);
    h.wakes.complete(wake);
    assert.equal((await h.current()).assignedAt, undefined);

    const reborn = h.restart();
    await reborn.reconcileKnownCycles(5_000);
    await reborn.reconcileKnownCycles(6_000);
    const recovered = await h.current();
    assert.equal(recovered.assignmentMessageId, wake, 'the same key returns the same wake');
    assert.equal(recovered.assignedAt, 150, 'and its receipt still dates the clock exactly');
    assert.equal(h.wakes.triggers.length, 1);
    assert.deepEqual(h.wakes.poisonRows, []);
  });

  test('concurrent sends of one wake share one delivery', async () => {
    const h = await harness();
    const requested = await h.current();
    await Promise.all([h.coordinator.ensureAssignment(requested), h.coordinator.ensureAssignment(requested)]);
    assert.equal(h.wakes.deliveries.length, 1);
    assert.equal(h.wakes.triggers.length, 1);
    assert.deepEqual(h.wakes.poisonRows, []);
  });

  test('a wake that can never be delivered does not freeze the cycle forever', async () => {
    const h = await harness();
    await h.coordinator.reconcileKnownCycles(100);
    h.wakes.cancel((await h.current()).assignmentMessageId); // the operator cleared the queue before it ran

    await h.coordinator.reconcileKnownCycles(1_000);
    const abandoned = await h.current();
    assert.equal(abandoned.pendingWakeMessageId, undefined);
    assert.equal(abandoned.assignedAt, 1_000, 'the bounded retry clock starts when the loss is observed');

    await h.coordinator.reconcileKnownCycles(1_000 + T - 1);
    assert.equal(h.wakes.count('Retrigger'), 0);
    await h.coordinator.reconcileKnownCycles(1_000 + T);
    const retriggered = await h.current();
    assert.equal(retriggered.evalStatus, 'retriggered');
    assert.equal(
      retriggered.pendingWakeMessageId,
      retriggered.retriggerMessageId,
      'the retry is a fresh custodied wake',
    );
  });
});
