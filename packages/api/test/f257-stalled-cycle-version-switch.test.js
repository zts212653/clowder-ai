// F257: an operator version transition (switch or create) is the cat-free exit
// from a stalled evaluation cycle. It terminates the cycle with
// manual-version-switch provenance, keeps the frozen evaluation window on the
// archived record, and opens the next cycle at the transition timestamp.
// In-flight statuses (requested / retriggered / written) keep blocking it.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catalog, catalogWithThreshold, FakeRedis, stalledRecord } from './f257-stalled-cycle-fixture.js';

const { CycleRecordStore } = await import('../dist/infrastructure/harness-eval/evaluation/CycleRecordStore.js');
const { CycleTriggerChecker } = await import('../dist/infrastructure/harness-eval/evaluation/CycleTriggerChecker.js');
const { ManualVersionCycleService } = await import(
  '../dist/infrastructure/harness-eval/evaluation/ManualVersionCycleService.js'
);

describe('F257 stalled cycle exits: operator version transition', () => {
  function switchHarness({ episodes = [], evaluationCatalog = catalog } = {}) {
    const redis = new FakeRedis();
    const store = new CycleRecordStore(redis);
    const checker = new CycleTriggerChecker({
      catalog: evaluationCatalog,
      cycles: store,
      traces: {
        async ensureOwnerEpisodeBackfilled() {},
        async getEpisodeByInvocationId() {
          return null;
        },
        async countOwnerWindow(_owner, start, end) {
          return episodes.filter((at) => at >= start && at < end).length;
        },
        async earliestOwnerEpisode() {
          return null;
        },
      },
      annotations: {
        async queryMetricWindow() {
          return [];
        },
      },
      resolveVersion: () => ({ version: 'v1', versionContentRef: 'hooks:D1@1' }),
    });
    let activeVersion = 1;
    const service = new ManualVersionCycleService({
      runtime: {
        catalog: evaluationCatalog,
        cycles: store,
        cycleChecker: checker,
        async resolveVersion() {
          return { version: 'v2', versionContentRef: 'hooks:D1@2' };
        },
        async resolveSegmentVersion(ref) {
          return Number(ref.match(/@([0-9]+)$/)?.[1] ?? 0);
        },
      },
      overrideStore: {
        async getActiveVersion() {
          return activeVersion;
        },
        async activateVersion(_segmentId, version) {
          activeVersion = version;
        },
        async hasVersion() {
          return true;
        },
        async setContentOverride() {
          activeVersion = 2;
        },
      },
      async refreshOverrideSnapshot() {},
      now: () => 1_500,
    });
    return { store, checker, service, activeVersion: () => activeVersion };
  }

  test('switching the version terminates a stalled cycle and keeps its frozen evaluation window', async () => {
    const { store, service, activeVersion } = switchHarness();
    const stalled = await stalledRecord(store);

    const switched = await service.switch({
      ownerUserId: 'owner-1',
      segmentId: 'D1',
      targetVersion: 2,
      actorId: 'owner-1',
      reason: '评估停滞，切到 v2 继续',
    });

    assert.equal(activeVersion(), 2);
    assert.equal(switched.archivedCycleId, stalled.cycleId);
    const archived = await store.historyCycle('owner-1', 'obj', stalled.cycleId);
    assert.equal(archived.evalStatus, 'stalled', 'the archived record keeps the honest terminal status');
    assert.deepEqual(archived.windows, [{ start: 0, end: 1_000 }], 'the frozen evaluation window is preserved');
    assert.equal(archived.stalledAt, 1_200);
    assert.equal(archived.cycleEnd, 1_500);
    assert.equal(archived.closedAt, 1_500);
    assert.equal(archived.termination.kind, 'manual-version-switch');
    assert.equal(archived.termination.at, 1_500);
    assert.equal(switched.currentCycle.evalStatus, 'idle');
    assert.equal(switched.currentCycle.cycleStart, 1_500);
    assert.equal(switched.currentCycle.versionContentRef, 'hooks:D1@2');
    assert.deepEqual(switched.currentCycle.carryoverWindows, [
      {
        start: 0,
        end: 1_500,
        provenance: {
          kind: 'manual-version-switch',
          sourceCycleId: stalled.cycleId,
          sourceVersion: 'v1',
          sourceVersionContentRef: 'hooks:D1@1',
          sourceSegmentId: 'D1',
          sourceSegmentVersion: 1,
        },
      },
    ]);
  });

  test('creating a version from a stalled cycle goes through the same termination', async () => {
    const { store, service } = switchHarness();
    const stalled = await stalledRecord(store);
    const created = await service.create({
      ownerUserId: 'owner-1',
      segmentId: 'D1',
      content: 'edited {{X}}',
      baseVersion: 1,
      expectedActiveVersion: 1,
      actorId: 'owner-1',
      reason: '评估停滞，基于 v1 产生新版本',
    });
    assert.equal(created.archivedCycleId, stalled.cycleId);
    assert.equal((await store.historyCycle('owner-1', 'obj', stalled.cycleId)).termination.baseVersion, 1);
    assert.equal(created.currentCycle.evalStatus, 'idle');
  });

  test('an evaluation that is still in flight keeps blocking the operator transition', async () => {
    const { store, service, activeVersion } = switchHarness();
    const idle = await store.initialize('owner-1', 'obj', 0, { version: 'v1', versionContentRef: 'hooks:D1@1' });
    const requested = { ...idle, cycleEnd: 1_000, evalStatus: 'requested', windows: [{ start: 0, end: 1_000 }] };
    assert.equal(await store.request(idle, requested), true);
    for (const status of ['requested', 'retriggered', 'written']) {
      const current = await store.current('owner-1', 'obj');
      if (current.evalStatus !== status)
        assert.equal(await store.transition(current, { ...current, evalStatus: status }), true);
      await assert.rejects(
        service.switch({
          ownerUserId: 'owner-1',
          segmentId: 'D1',
          targetVersion: 2,
          actorId: 'owner-1',
          reason: 'wait',
        }),
        /manual_version_switch_evaluation_in_progress/,
      );
    }
    assert.equal(activeVersion(), 1, 'a blocked switch never mutates the active version');
  });

  /** One real insufficient-evidence cycle [0,100], then a fresh idle cycle at 100 — built by the production checker/store. */
  async function afterOneSkippedCycle(h) {
    await h.store.initialize('owner-1', 'obj', 0, { version: 'v1', versionContentRef: 'hooks:D1@1' });
    const first = await h.checker.checkObjective('owner-1', 'obj', 100);
    assert.equal(first.status, 'requested');
    assert.deepEqual(first.record.windows, [{ start: 0, end: 100 }]);
    const evaluation = { metrics: [], overall: 'insufficient_evidence', writtenAt: 100, by: 'cat-default' };
    const completed = { ...first.record, evalStatus: 'written', evaluation, closedAt: 100 };
    const next = await h.store.advance(first.record, completed, { version: 'v1', versionContentRef: 'hooks:D1@1' });
    assert.equal(next.cycleStart, 100);
    return first.record;
  }

  const provenanceOf = (cycleId) => ({
    kind: 'manual-version-switch',
    sourceCycleId: cycleId,
    sourceVersion: 'v1',
    sourceVersionContentRef: 'hooks:D1@1',
    sourceSegmentId: 'D1',
    sourceSegmentVersion: 1,
  });

  test('a stalled cycle frozen over a prior insufficient-evidence window carries every window into the next assignment', async () => {
    const episodes = [50, 150];
    const h = switchHarness({ episodes, evaluationCatalog: catalogWithThreshold(1) });
    await afterOneSkippedCycle(h);
    const second = await h.checker.checkObjective('owner-1', 'obj', 200);
    assert.equal(second.status, 'requested');
    assert.deepEqual(
      second.record.windows,
      [
        { start: 0, end: 100 },
        { start: 100, end: 200 },
      ],
      'production frozen set',
    );
    const retriggered = { ...second.record, evalStatus: 'retriggered', retriggeredAt: 210 };
    assert.equal(await h.store.transition(second.record, retriggered), true);
    const stalled = { ...retriggered, evalStatus: 'stalled', stalledAt: 220 };
    assert.equal(await h.store.transition(retriggered, stalled), true);

    const switched = await h.service.switch({
      ownerUserId: 'owner-1',
      segmentId: 'D1',
      targetVersion: 2,
      actorId: 'owner-1',
      reason: '评估停滞，切到 v2',
    });
    const provenance = provenanceOf(stalled.cycleId);
    assert.deepEqual(switched.currentCycle.carryoverWindows, [
      { start: 0, end: 100, provenance },
      { start: 100, end: 1_500, provenance },
    ]);

    episodes.push(1_600);
    const third = await h.checker.checkObjective('owner-1', 'obj', 1_700);
    assert.equal(third.status, 'requested');
    assert.deepEqual(third.record.windows, [
      { start: 0, end: 100, provenance },
      { start: 100, end: 1_500, provenance },
      { start: 1_500, end: 1_700 },
    ]);
    const { buildCycleAssignment } = await import(
      '../dist/infrastructure/harness-eval/evaluation/CycleEvaluationContent.js'
    );
    const assignment = await buildCycleAssignment(
      {
        catalog: catalogWithThreshold(1),
        annotations: {
          async queryMetricWindow() {
            return [];
          },
        },
        history: await h.store.history('owner-1', 'obj', 2),
      },
      third.record,
    );
    assert.equal(assignment.windows.length, 3, 'the next assignment still reads every unconsumed window');
    assert.equal(
      assignment.priorSkipReasons,
      undefined,
      'carried windows are never mis-indexed as native skip windows',
    );
  });

  test('an idle cycle that follows an insufficient-evidence cycle keeps that window through a version switch', async () => {
    const h = switchHarness({ episodes: [50], evaluationCatalog: catalogWithThreshold(1) });
    await afterOneSkippedCycle(h);
    const idle = await h.store.current('owner-1', 'obj');
    assert.equal(idle.evalStatus, 'idle');
    const switched = await h.service.switch({
      ownerUserId: 'owner-1',
      segmentId: 'D1',
      targetVersion: 2,
      actorId: 'owner-1',
      reason: '切到 v2',
    });
    const provenance = provenanceOf(idle.cycleId);
    assert.deepEqual(switched.currentCycle.carryoverWindows, [
      { start: 0, end: 100, provenance },
      { start: 100, end: 1_500, provenance },
    ]);
  });
});
