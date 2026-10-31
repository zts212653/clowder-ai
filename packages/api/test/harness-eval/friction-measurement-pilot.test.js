import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildFrictionMeasurementReport,
  captureFrictionMeasurementPilot,
} from '../../dist/infrastructure/harness-eval/friction/friction-measurement-pilot.js';
import { TaskOutcomeEpisodeStore } from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-store.js';

const WINDOW = { windowStartMs: 1_000, windowEndMs: 4_000 };

function selector(overrides = {}) {
  return { kind: 'friction-rollup-snapshot', ...WINDOW, ...overrides };
}

function storedRow(id, category, type, createdAt = '1970-01-01T00:00:02.000Z') {
  return { id, episodeId: `ep-${id}`, category, record: { type }, createdAt };
}

function quietDeps(taskOutcomeStore, overrides = {}) {
  return {
    messageStore: { getBefore: async () => [] },
    taskOutcomeStore,
    frustrationIssueStore: { listConfirmedInWindow: async () => [] },
    harnessFeedbackRoot: '/path/that/does/not/exist',
    now: () => 5_000,
    ...overrides,
  };
}

function signal(id, channel) {
  return {
    id,
    channel,
    timestamp: '1970-01-01T00:00:02.000Z',
    symptom: `${channel} symptom`,
    rawRef: `${id}:raw`,
    severity: 'medium',
  };
}

function cluster(clusterId, members) {
  return {
    clusterId,
    representative: clusterId,
    channels: [...new Set(members.map((member) => member.channel))].sort(),
    count: members.length,
    members: members.map((member) => ({ signalId: member.id, rawRef: member.rawRef, channel: member.channel })),
    method: 'rule',
  };
}

function classified(base, extra = {}) {
  return { ...base, sensorForms: ['act'], severity: 'medium', ...extra };
}

function captureFixture({ expectedIds = ['cancel:1'], actualIds = expectedIds, degraded = false } = {}) {
  const paw = signal('paw-feel:m1#0', 'paw-feel');
  const cancelOne = signal('cancel:1', 'cancel');
  const cancelTwo = signal('cancel:2', 'cancel');
  const evalSignal = signal('eval-domain:v1#c#m', 'eval-domain');
  const actionableCluster = cluster('cluster-actionable', [paw, cancelOne]);
  const tailCluster = cluster('cluster-tail', [cancelTwo]);
  const referenceCluster = cluster('cluster-reference', [evalSignal]);
  const signals = [paw, cancelOne, cancelTwo, evalSignal];
  const input = {
    window: { sinceMs: WINDOW.windowStartMs, untilMs: WINDOW.windowEndMs },
    signals,
    clusters: [actionableCluster, tailCluster, referenceCluster],
    degraded,
    droppedChannels: degraded ? ['user-feedback'] : [],
  };
  return {
    capturedAt: '1970-01-01T00:00:05.000Z',
    expectedCancelIds: expectedIds,
    channelCaptures: {
      'paw-feel': { status: 'ok', emittedIds: [paw.id, 'paw-feel:filtered#0'] },
      cancel: { status: 'ok', emittedIds: actualIds },
      'user-feedback': degraded
        ? { status: 'error', emittedIds: [], errorCode: 'source_pull_failed' }
        : { status: 'ok', emittedIds: [] },
      'eval-domain': { status: 'ok', emittedIds: [evalSignal.id] },
    },
    rollupInput: input,
    rollupReport: {
      window: input.window,
      generatedAt: '1970-01-01T00:00:05.000Z',
      topClusters: [classified(actionableCluster), classified(referenceCluster)],
      actionableCandidates: [
        classified(actionableCluster, {
          actionability: 'actionable_candidate',
          followupDraft: {
            clusterId: actionableCluster.clusterId,
            title: 'investigate',
            summary: 'investigate',
            evidenceRefs: [],
            reportingMode: 'final-only',
          },
          referenceOnlyEvidenceRefs: [],
        }),
      ],
      referenceOnly: [
        classified(referenceCluster, {
          actionability: 'reference_only',
          evidenceRefs: [],
        }),
      ],
      tailSummary: { clusterCount: 1, signalCount: 1, byChannel: { cancel: 1 } },
      degraded,
      droppedChannels: degraded ? ['user-feedback'] : [],
      tokenBudget: { cap: 4_000, estimated: 100 },
    },
  };
}

test('captures one canonical cancel snapshot and runs CancelAdapter against only that frozen view', async () => {
  let calls = 0;
  const rows = [
    storedRow(7, 'a2', 'permission_cancel'),
    storedRow(9, 'proxy', 'cancel_burst'),
    storedRow(10, 'a2', 'magic_word_ref'),
  ];
  const taskOutcomeStore = {
    listSignalsInWindow(sinceMs, untilMs, categories) {
      calls += 1;
      assert.deepEqual([sinceMs, untilMs, categories], [1_000, 4_000, ['a2', 'proxy']]);
      return calls === 1 ? rows : [storedRow(99, 'a2', 'permission_cancel')];
    },
  };

  const capture = await captureFrictionMeasurementPilot(quietDeps(taskOutcomeStore), selector());

  assert.equal(calls, 1);
  assert.deepEqual(capture.expectedCancelIds, ['cancel:7', 'cancel:9']);
  assert.deepEqual(capture.channelCaptures.cancel, {
    status: 'ok',
    emittedIds: ['cancel:7', 'cancel:9'],
  });
  assert.deepEqual(
    capture.rollupInput.signals.filter((item) => item.channel === 'cancel').map((item) => item.id),
    ['cancel:7', 'cancel:9'],
  );
});

test('reconciles per-ID cancel recall against the real TaskOutcomeEpisodeStore read model', async () => {
  const store = new TaskOutcomeEpisodeStore(':memory:');
  const episode = store.createEpisode({ trigger: 'user_ask', threadId: 'thread-f267', participants: ['codex-sol'] });
  store.appendSignal(episode.episodeId, { category: 'a2', record: { type: 'permission_cancel' } });
  store.appendSignal(episode.episodeId, { category: 'a2', record: { type: 'magic_word_ref' } });
  store.appendSignal(episode.episodeId, { category: 'proxy', record: { type: 'cancel_burst', value: 3 } });
  const capturedAtMs = Date.now() + 1_000;
  const capture = await captureFrictionMeasurementPilot(
    quietDeps(store, { now: () => capturedAtMs }),
    selector({ windowStartMs: capturedAtMs - 60_000, windowEndMs: capturedAtMs }),
  );
  const report = buildFrictionMeasurementReport(capture);

  assert.equal(report.cancelJoin.status, 'complete');
  assert.equal(report.cancelJoin.recall, 1);
  assert.equal(report.cancelJoin.expectedIds.length, 2);
  assert.deepEqual(report.cancelJoin.actualIds, report.cancelJoin.expectedIds);
  assert.deepEqual(report.cancelJoin.missingIds, []);
  assert.deepEqual(report.cancelJoin.extraIds, []);
});

test('rejects an open/future window before reading the canonical store', async () => {
  let calls = 0;
  const taskOutcomeStore = {
    listSignalsInWindow() {
      calls += 1;
      return [];
    },
  };

  await assert.rejects(
    captureFrictionMeasurementPilot(quietDeps(taskOutcomeStore), selector({ windowEndMs: 5_001 })),
    /friction_pilot_window_not_closed/,
  );
  assert.equal(calls, 0);
});

test('captures a source failure as channel provenance while replaying the other captured channels', async () => {
  const taskOutcomeStore = {
    listSignalsInWindow: () => [storedRow(7, 'a2', 'permission_cancel')],
  };
  const capture = await captureFrictionMeasurementPilot(
    quietDeps(taskOutcomeStore, {
      messageStore: {
        async getBefore() {
          throw new Error('PRIVATE SOURCE ERROR');
        },
      },
    }),
    selector(),
  );

  assert.deepEqual(capture.channelCaptures['paw-feel'], {
    status: 'error',
    emittedIds: [],
    errorCode: 'source_pull_failed',
  });
  assert.deepEqual(capture.channelCaptures.cancel, { status: 'ok', emittedIds: ['cancel:7'] });
  assert.deepEqual(capture.rollupInput.droppedChannels, ['paw-feel']);
  assert.doesNotMatch(JSON.stringify(capture.channelCaptures), /PRIVATE SOURCE ERROR/);
});

test('projects an honest four-channel funnel without treating no drops as opportunity coverage', () => {
  const report = buildFrictionMeasurementReport(captureFixture());

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.baselineKind, 'prospective_paired_capture');
  assert.deepEqual(report.historicalBaseline, {
    classification: 'symptom_cohort',
    rollupCount: 11,
    limitation: 'historical_rollups_lack_frozen_canonical_row_ids',
  });
  assert.deepEqual(report.cancelJoin, {
    status: 'complete',
    expectedIds: ['cancel:1'],
    actualIds: ['cancel:1'],
    intersectionIds: ['cancel:1'],
    missingIds: [],
    extraIds: [],
    recall: 1,
  });
  assert.deepEqual(report.channels.cancel.opportunity, {
    status: 'measured',
    ids: ['cancel:1'],
    provenance: 'frozen_task_outcome_rows',
  });
  assert.equal(report.channels['paw-feel'].opportunity.status, 'unmeasured');
  assert.equal(report.channels['user-feedback'].opportunity.status, 'unmeasured');
  assert.equal(report.channels['eval-domain'].opportunity.status, 'unmeasured');
  assert.deepEqual(report.channels['paw-feel'].aggregate.excludedIds, ['paw-feel:filtered#0']);
  assert.deepEqual(report.channels.cancel.actionable.ids, ['cancel:1']);
  assert.deepEqual(report.channels.cancel.actionable.excludedIds, ['cancel:2']);
  assert.deepEqual(report.channels['eval-domain'].eligibility.excludedIds, ['eval-domain:v1#c#m']);
  assert.deepEqual(report.decision, {
    status: 'usable',
    reasons: [],
    withdrawalConditions: ['withdraw_if_source_contract_or_window_identity_changes'],
  });
});

test('keeps adapter join status separate from channel and downstream degradation', () => {
  const report = buildFrictionMeasurementReport(captureFixture({ degraded: true }));

  assert.equal(report.cancelJoin.status, 'complete');
  assert.equal(report.channels['user-feedback'].adapter.status, 'error');
  assert.equal(report.channels['user-feedback'].adapter.errorCode, 'source_pull_failed');
  assert.equal(report.decision.status, 'insufficient');
  assert.deepEqual(report.decision.reasons, ['adapter_error:user-feedback', 'downstream_degraded']);
  assert.deepEqual(report.decision.withdrawalConditions, [
    'rerun_after_failed_channel_recovers:user-feedback',
    'rerun_after_downstream_dependencies_recover',
  ]);
});

test('does not turn a cancel adapter error into a zero-recall point estimate', () => {
  const capture = captureFixture({ expectedIds: ['cancel:1', 'cancel:2'], actualIds: [] });
  capture.channelCaptures.cancel = { status: 'error', emittedIds: [], errorCode: 'source_pull_failed' };

  const report = buildFrictionMeasurementReport(capture);

  assert.equal(report.cancelJoin.status, 'unavailable');
  assert.equal(report.cancelJoin.recall, null);
  assert.deepEqual(report.cancelJoin.missingIds, []);
  assert.deepEqual(report.decision.reasons, ['cancel_join:unavailable', 'adapter_error:cancel']);
});

test('classifies missing, extra, mixed, and zero-opportunity joins without a point estimate for zero n', () => {
  const cases = [
    { expectedIds: ['cancel:1', 'cancel:2'], actualIds: ['cancel:1'], status: 'adapter_gap', recall: 0.5 },
    { expectedIds: ['cancel:1'], actualIds: ['cancel:1', 'cancel:3'], status: 'unexpected_output', recall: 1 },
    { expectedIds: ['cancel:1', 'cancel:2'], actualIds: ['cancel:1', 'cancel:3'], status: 'mismatch', recall: 0.5 },
    { expectedIds: [], actualIds: [], status: 'no_opportunity', recall: null },
  ];

  for (const item of cases) {
    const report = buildFrictionMeasurementReport(
      captureFixture({ expectedIds: item.expectedIds, actualIds: item.actualIds }),
    );
    assert.equal(report.cancelJoin.status, item.status);
    assert.equal(report.cancelJoin.recall, item.recall);
    assert.equal(report.decision.status, 'insufficient');
  }
});

test('serializes provenance IDs and counts without raw source content', () => {
  const capture = captureFixture();
  capture.rollupInput.signals[0].sourceEvidence = 'PRIVATE RAW MESSAGE';
  capture.rollupInput.signals[1].symptom = 'permission cancel (PRIVATE REASON)';

  const serialized = JSON.stringify(buildFrictionMeasurementReport(capture));

  assert.doesNotMatch(serialized, /PRIVATE RAW MESSAGE|PRIVATE REASON|"(?:sourceEvidence|symptom|rawRef)":/);
});
