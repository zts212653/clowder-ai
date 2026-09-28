import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { publicTestSelectionHash } from '../scripts/resolve-public-test-files.mjs';
import {
  summarizePublicTestMeasurementHistory,
  summarizePublicTestShardReports,
} from '../scripts/summarize-public-test-shards.mjs';

const selectedFiles = ['test/pure.test.js', 'test/serial.test.js'];
const provenance = {
  workspaceTree: 'a'.repeat(40),
  lockfileHash: 'b'.repeat(64),
  nodeVersion: 'v24.16.0',
  pnpmVersion: '10.0.0',
  platform: 'linux',
  arch: 'x64',
};
const plan = {
  schemaVersion: 2,
  selectedFiles,
  selectionHash: publicTestSelectionHash(selectedFiles),
  exclusionRegistryHash: 'e'.repeat(64),
  classificationVersion: 2,
  plannerProvenance: provenance,
  timingSource: { kind: 'unmeasured_default', estimatedDurationMs: 1_000 },
  sharedSerialLane: { id: 'serial-shared', files: ['test/serial.test.js'], estimatedDurationMs: 20 },
  distributableShards: [
    { id: 'distributable-1', files: ['test/pure.test.js'], estimatedDurationMs: 10 },
    { id: 'distributable-2', files: [], estimatedDurationMs: 0 },
    { id: 'distributable-3', files: [], estimatedDurationMs: 0 },
    { id: 'distributable-4', files: [], estimatedDurationMs: 0 },
    { id: 'distributable-5', files: [], estimatedDurationMs: 0 },
    { id: 'distributable-6', files: [], estimatedDurationMs: 0 },
  ],
  assignments: {
    'test/pure.test.js': {
      lane: 'distributable-1',
      ruleId: 'runtime-isolated-default',
      estimatedDurationMs: 10,
      isolationEvidence: { kind: 'kernel-no-egress-plus-runtime-guard' },
    },
    'test/serial.test.js': {
      lane: 'serial-shared',
      ruleId: 'shared-fixture',
      estimatedDurationMs: 20,
      sharedResourceEvidence: { kind: 'explicit-shared-resource', scope: 'shared-account', source: 'fixture' },
    },
  },
};

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

plan.planFingerprint = createHash('sha256')
  .update(JSON.stringify(stable(plan)))
  .digest('hex');

function report(lane, files, elapsedMs) {
  return {
    schemaVersion: 2,
    kind: 'public_test_shard_run',
    status: 'succeeded',
    lane,
    planFingerprint: plan.planFingerprint,
    selectionHash: plan.selectionHash,
    exclusionRegistryHash: plan.exclusionRegistryHash,
    elapsedMs,
    provenance,
    files: files.map((file, index) => ({
      file,
      status: 'passed',
      durationMs: index + 1,
      failureCategory: 'passed',
    })),
  };
}

function greenReports() {
  return [
    report('serial-shared', ['test/serial.test.js'], 20),
    report('distributable-1', ['test/pure.test.js'], 10),
    report('distributable-2', [], 2),
    report('distributable-3', [], 3),
    report('distributable-4', [], 4),
    report('distributable-5', [], 5),
    report('distributable-6', [], 6),
  ];
}

describe('F308 public-test shard summary', () => {
  it('proves exact-once selected coverage and reports critical path and runner minutes', () => {
    const summary = summarizePublicTestShardReports({ plan, reports: greenReports() });
    assert.equal(summary.selectedFileCount, 2);
    assert.equal(summary.criticalPathMs, 20);
    assert.equal(summary.sharedSerialLaneMs, 20);
    assert.equal(summary.distributableCriticalPathMs, 10);
    assert.equal(summary.distributableAggregateMs, 30);
    assert.ok(Math.abs(summary.runnerMinutes - (20 + 10 + 2 + 3 + 4 + 5 + 6) / 60_000) < Number.EPSILON);
    assert.deepEqual(Object.keys(summary.perFileTimings), selectedFiles);
  });

  it('fails closed when the measured critical path exceeds the enforced budget', () => {
    assert.throws(
      () =>
        summarizePublicTestShardReports({
          plan,
          reports: greenReports(),
          maxCriticalPathMs: 19,
        }),
      /critical path 20ms exceeds budget 19ms/,
    );
  });

  it('rejects missing, duplicate, stale, or non-green shard reports rather than manufacturing a green aggregate', () => {
    assert.throws(
      () => summarizePublicTestShardReports({ plan, reports: greenReports().slice(0, -1) }),
      /missing public-test shard report/,
    );
    assert.throws(
      () =>
        summarizePublicTestShardReports({
          plan,
          reports: [...greenReports(), report('distributable-1', ['test/pure.test.js'], 10)],
        }),
      /duplicate report/,
    );
    const stale = greenReports();
    stale[0].selectionHash = 'd'.repeat(64);
    assert.throws(() => summarizePublicTestShardReports({ plan, reports: stale }), /selection hash/);
    const failed = greenReports();
    failed[0].status = 'failed';
    assert.throws(() => summarizePublicTestShardReports({ plan, reports: failed }), /not green/);
  });

  it('requires three identical-selection runs before it reports p50/p95 against the target', () => {
    const base = summarizePublicTestShardReports({ plan, reports: greenReports() });
    const history = summarizePublicTestMeasurementHistory([
      { ...base, criticalPathMs: 550_000 },
      { ...base, criticalPathMs: 600_000 },
      { ...base, criticalPathMs: 700_000 },
    ]);
    assert.equal(history.p50CriticalPathMs, 600_000);
    assert.equal(history.p95CriticalPathMs, 700_000);
    assert.equal(history.targetMet, true);
    assert.throws(() => summarizePublicTestMeasurementHistory([base, base]), /at least three/);
  });
});
