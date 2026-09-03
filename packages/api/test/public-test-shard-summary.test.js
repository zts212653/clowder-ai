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
  schemaVersion: 1,
  selectedFiles,
  selectionHash: publicTestSelectionHash(selectedFiles),
  exclusionRegistryHash: 'e'.repeat(64),
  classificationVersion: 1,
  plannerProvenance: provenance,
  timingSource: { kind: 'unmeasured_default', estimatedDurationMs: 1_000 },
  lanes: { serial: { files: ['test/serial.test.js'], estimatedDurationMs: 20 } },
  pureShards: [
    { id: 'pure-1', files: ['test/pure.test.js'], estimatedDurationMs: 10 },
    { id: 'pure-2', files: [], estimatedDurationMs: 0 },
    { id: 'pure-3', files: [], estimatedDurationMs: 0 },
    { id: 'pure-4', files: [], estimatedDurationMs: 0 },
  ],
  assignments: {
    'test/pure.test.js': { lane: 'pure-1', ruleId: 'pure', estimatedDurationMs: 10 },
    'test/serial.test.js': { lane: 'serial', ruleId: 'stateful', estimatedDurationMs: 20 },
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
    schemaVersion: 1,
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
    report('serial', ['test/serial.test.js'], 20),
    report('pure-1', ['test/pure.test.js'], 10),
    report('pure-2', [], 2),
    report('pure-3', [], 3),
    report('pure-4', [], 4),
  ];
}

describe('F308 public-test shard summary', () => {
  it('proves exact-once selected coverage and reports critical path and runner minutes', () => {
    const summary = summarizePublicTestShardReports({ plan, reports: greenReports() });
    assert.equal(summary.selectedFileCount, 2);
    assert.equal(summary.criticalPathMs, 20);
    assert.equal(summary.serialLaneMs, 20);
    assert.ok(Math.abs(summary.runnerMinutes - (20 + 10 + 2 + 3 + 4) / 60_000) < Number.EPSILON);
    assert.deepEqual(Object.keys(summary.perFileTimings), selectedFiles);
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
          reports: [...greenReports(), report('serial', ['test/serial.test.js'], 20)],
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
