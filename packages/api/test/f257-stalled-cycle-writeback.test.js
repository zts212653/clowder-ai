// F257: `stalled` is not an absorbing state. Once both bounded nudges (one
// 30-minute retrigger, then the stall alert) are spent, a late evaluation
// writeback from the Objective thread is still accepted and flows into
// governance exactly like an on-time one. Production 2026-09-15:
// tool-access-correct-use stalled and read/submit both answered 409.

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

const { CycleEvaluationCoordinator, CYCLE_WRITEBACK_TIMEOUT_MS } = await import(
  '../dist/infrastructure/harness-eval/evaluation/CycleEvaluationCoordinator.js'
);
const { CycleRecordStore } = await import('../dist/infrastructure/harness-eval/evaluation/CycleRecordStore.js');

/** idle → requested (frozen window [0, 1000]) → assigned → one retrigger → stalled. */
async function stalledHarness() {
  const redis = new FakeRedis();
  const cycles = new CycleRecordStore(redis);
  const idle = await cycles.initialize('owner-1', 'obj', 0, { version: 'v1', versionContentRef: 'hooks:D1@1' });
  const requested = { ...idle, cycleEnd: 1_000, evalStatus: 'requested', windows: [{ start: 0, end: 1_000 }] };
  assert.equal(await cycles.request(idle, requested), true);
  const traces = [trace('inv-1', 500)];
  const runtime = {
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
  };
  // An idle evaluation thread: every wake is queued, custodied, and started at once (clock 5_000).
  const wakeQueue = new FakeWakeQueue({ clock: { now: 5_000 } });
  const { deliveries } = wakeQueue;
  const written = [];
  const coordinator = new CycleEvaluationCoordinator({
    runtime,
    threadStore: new FakeThreadStore(),
    messageStore: wakeQueue.messageStore,
    deliver: wakeQueue.deliver,
    getInvokeTrigger: () => wakeQueue.invokeTrigger,
    getDefaultCatId: () => 'cat-default',
    now: () => 5_000,
  });
  coordinator.setWrittenHandler((record) => {
    written.push(record);
  });
  const active = await cycles.current('owner-1', 'obj');
  assert.equal(
    await cycles.transition(active, { ...active, assignedAt: 100, assignmentMessageId: 'assignment' }),
    true,
  );
  await coordinator.reconcileKnownCycles(100 + CYCLE_WRITEBACK_TIMEOUT_MS);
  await coordinator.reconcileKnownCycles(101 + CYCLE_WRITEBACK_TIMEOUT_MS); // observes the retrigger's delivery receipt
  const retriggered = await cycles.current('owner-1', 'obj');
  await coordinator.reconcileKnownCycles(retriggered.retriggeredAt + CYCLE_WRITEBACK_TIMEOUT_MS);
  const stalled = await cycles.current('owner-1', 'obj');
  assert.equal(stalled.evalStatus, 'stalled', 'precondition: the cycle reached stalled');
  return { redis, cycles, coordinator, deliveries, written, stalled };
}

describe('F257 stalled cycle exits: late writeback', () => {
  test('a stalled cycle still serves its trace pool and accepts a late evaluation into governance', async () => {
    const { cycles, coordinator, written, stalled } = await stalledHarness();

    const page = await coordinator.readTraces(principal, {
      objectiveId: 'obj',
      cycleId: stalled.cycleId,
      cursor: 0,
      limit: 10,
    });
    assert.equal(page.cycleId, stalled.cycleId);
    assert.equal(page.total, 1, 'the frozen window is still readable');

    const result = await coordinator.submitEvaluation(principal, { ...submission, cycleId: stalled.cycleId });
    assert.equal(result.outcome, 'written');
    const current = await cycles.current('owner-1', 'obj');
    assert.equal(current.cycleId, stalled.cycleId);
    assert.equal(current.evalStatus, 'written');
    assert.equal(current.stalledAt, stalled.stalledAt, 'the stall history stays on the record');
    assert.equal(written.length, 1, 'the written handler hands the late evaluation to governance');
  });

  test('a stalled cycle archives as insufficient evidence and the next cycle starts at the frozen end', async () => {
    const { cycles, coordinator, stalled } = await stalledHarness();
    const result = await coordinator.submitEvaluation(principal, {
      ...submission,
      cycleId: stalled.cycleId,
      overall: 'insufficient_evidence',
    });
    assert.equal(result.outcome, 'written');
    assert.ok(result.nextCycleId);
    const current = await cycles.current('owner-1', 'obj');
    assert.equal(current.evalStatus, 'idle');
    assert.equal(current.cycleStart, 1_000);
    const archived = await cycles.historyCycle('owner-1', 'obj', stalled.cycleId);
    assert.equal(archived.evaluation.overall, 'insufficient_evidence');
  });

  test('a stalled cycle that an operator already terminated rejects a late writeback as not active', async () => {
    const { redis, cycles, coordinator, stalled } = await stalledHarness();
    const terminated = {
      ...stalled,
      cycleEnd: 2_000,
      closedAt: 2_000,
      termination: {
        kind: 'manual-version-switch',
        segmentId: 'D1',
        fromVersion: 1,
        toVersion: 2,
        at: 2_000,
        by: 'owner-1',
        reason: 'moved on',
      },
    };
    redis.strings.set(`harness-cycle-history:owner-1:obj:${stalled.cycleId}`, JSON.stringify(terminated));
    await redis.zadd('harness-cycle-history-index:owner-1:obj', 2_000, stalled.cycleId);
    const replacement = await cycles.initialize('owner-1', 'obj-fresh', 2_000, {
      version: 'v2',
      versionContentRef: 'hooks:D1@2',
    });
    redis.strings.set('harness-cycle-current:owner-1:obj', JSON.stringify({ ...replacement, objectiveId: 'obj' }));

    await assert.rejects(
      coordinator.submitEvaluation(principal, { ...submission, cycleId: stalled.cycleId }),
      /cycle_evaluation_not_active:/,
    );
    await assert.rejects(
      coordinator.readTraces(principal, { objectiveId: 'obj', cycleId: stalled.cycleId, cursor: 0, limit: 10 }),
      /cycle_evaluation_not_found:/,
    );
  });

  test('the stall alert names both exits instead of only announcing that retries stopped', async () => {
    const { deliveries } = await stalledHarness();
    const alert = deliveries.find((item) => item.content.includes('Stalled'));
    assert.ok(alert, 'one stall alert was delivered');
    assert.match(alert.content, /late .*writeback|writeback .*still accepted/i);
    assert.match(alert.content, /version/i);
  });
});
