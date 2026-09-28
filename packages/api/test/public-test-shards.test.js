import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planPublicTestShards, validatePublicTestShardPlan } from '../scripts/plan-public-test-shards.mjs';
import { timingMapFromSummary } from '../scripts/plan-public-test-shards-cli.mjs';
import { publicTestArtifactFingerprint } from '../scripts/public-test-provenance.mjs';
import { publicTestSelectionHash } from '../scripts/resolve-public-test-files.mjs';

const selectedFiles = [
  'test/pure-alpha.test.js',
  'test/pure-beta.test.js',
  'test/pure-gamma.test.js',
  'test/pure-delta.test.js',
  'test/pure-epsilon.test.js',
  'test/redis-state.test.js',
  'test/fs-watch-state.test.js',
  'test/network-state.test.js',
];

const classification = {
  version: 2,
  defaultIsolationEvidence: {
    kind: 'kernel-no-egress-plus-runtime-guard',
    rulesVersion: 'f308-runtime-v2',
    source: 'every distributable file runs in a loopback-only network namespace and its own process',
  },
  sharedResources: [
    {
      id: 'network-state',
      match: '^test/network-state\\.test\\.js$',
      reason: 'fixture exercises one explicitly shared remote account',
      sharedResourceEvidence: {
        kind: 'explicit-shared-resource',
        scope: 'shared-account',
        source: 'fixture:shared-account',
      },
    },
  ],
};

const selectionHash = publicTestSelectionHash(selectedFiles);
const exclusionRegistryHash = 'f'.repeat(64);
const plannerProvenance = {
  workspaceTree: 'a'.repeat(40),
  lockfileHash: 'b'.repeat(64),
  nodeVersion: 'v24.16.0',
  pnpmVersion: '10.0.0',
  platform: 'linux',
  arch: 'x64',
};

describe('F308 public-test sharding', () => {
  it('assigns every selected file exactly once and keeps only proved shared resources globally serial', () => {
    const plan = planPublicTestShards({
      selectedFiles,
      selectionHash,
      exclusionRegistryHash,
      classification,
      plannerProvenance,
      timingByFile: {
        'test/pure-alpha.test.js': 20,
        'test/pure-beta.test.js': 19,
        'test/pure-gamma.test.js': 18,
        'test/pure-delta.test.js': 17,
        'test/pure-epsilon.test.js': 16,
      },
    });

    assert.equal(plan.schemaVersion, 2);
    assert.equal(plan.distributableShards.length, 6);
    assert.deepEqual(plan.sharedSerialLane.files, ['test/network-state.test.js']);
    assert.deepEqual(
      plan.distributableShards.flatMap((shard) => shard.files).sort(),
      selectedFiles.filter((file) => file !== 'test/network-state.test.js').sort(),
    );
    assert.doesNotThrow(() => validatePublicTestShardPlan(plan, selectedFiles));

    const assigned = [
      ...plan.sharedSerialLane.files,
      ...plan.distributableShards.flatMap((shard) => shard.files),
    ].sort();
    assert.deepEqual(assigned, [...selectedFiles].sort());
  });

  it('is reproducible when input order changes and uses duration balancing deterministically', () => {
    const options = {
      selectionHash,
      exclusionRegistryHash,
      classification,
      plannerProvenance,
      timingByFile: Object.fromEntries(selectedFiles.map((file, index) => [file, 50 - index])),
    };
    const first = planPublicTestShards({ ...options, selectedFiles });
    const second = planPublicTestShards({ ...options, selectedFiles: [...selectedFiles].reverse() });

    assert.deepEqual(first, second);
    assert.deepEqual(
      first.distributableShards.map((shard) => shard.estimatedDurationMs),
      [...first.distributableShards.map((shard) => shard.estimatedDurationMs)].sort((a, b) => a - b),
    );
  });

  it('uses locale-independent path ordering for deterministic shard ids', () => {
    const files = ['test/pure-z.test.js', 'test/pure-ä.test.js', 'test/pure-a.test.js', 'test/pure-b.test.js'];
    const plan = planPublicTestShards({
      selectedFiles: files,
      selectionHash: publicTestSelectionHash(files),
      exclusionRegistryHash,
      classification,
      plannerProvenance,
    });

    assert.deepEqual(
      plan.distributableShards.filter((shard) => shard.files.length > 0).map((shard) => shard.files[0]),
      ['test/pure-a.test.js', 'test/pure-b.test.js', 'test/pure-z.test.js', 'test/pure-ä.test.js'],
    );
  });

  it('fails closed for incomplete shared-resource evidence and duplicate/missing assignment', () => {
    assert.throws(
      () =>
        planPublicTestShards({
          selectedFiles: ['test/pure-alpha.test.js'],
          selectionHash: publicTestSelectionHash(['test/pure-alpha.test.js']),
          exclusionRegistryHash,
          classification: {
            ...classification,
            sharedResources: [{ id: 'unsafe', match: '.*', reason: 'missing evidence' }],
          },
          plannerProvenance,
        }),
      /sharedResourceEvidence/,
    );

    const plan = planPublicTestShards({
      selectedFiles,
      selectionHash,
      exclusionRegistryHash,
      classification,
      plannerProvenance,
    });
    plan.distributableShards[0].files.push('test/network-state.test.js');
    assert.throws(() => validatePublicTestShardPlan(plan, selectedFiles), /exactly once/);
  });

  it('places local state, dynamic imports, and temporary filesystem use in the same guarded distributable pool', () => {
    const plan = planPublicTestShards({
      selectedFiles,
      selectionHash,
      exclusionRegistryHash,
      classification,
      plannerProvenance,
    });

    assert.deepEqual(plan.sharedSerialLane.files, ['test/network-state.test.js']);
    assert.deepEqual(
      plan.distributableShards.flatMap((shard) => shard.files).sort(),
      selectedFiles.filter((file) => file !== 'test/network-state.test.js').sort(),
    );
  });

  it('rejects moving an explicit shared-resource file into a distributable shard', () => {
    const plan = planPublicTestShards({
      selectedFiles,
      selectionHash,
      exclusionRegistryHash,
      classification,
      plannerProvenance,
    });
    plan.sharedSerialLane.files = [];
    plan.distributableShards[0].files.push('test/network-state.test.js');
    plan.assignments['test/network-state.test.js'].lane = plan.distributableShards[0].id;
    assert.throws(() => validatePublicTestShardPlan(plan, selectedFiles), /shared resource assignment/);
  });

  it('only reuses timing from an exact green summary with matching selection and provenance', () => {
    const manifest = { selectedFiles: [...selectedFiles].sort(), selectionHash, exclusionRegistryHash };
    const summary = {
      schemaVersion: 1,
      kind: 'public_test_shard_summary',
      status: 'succeeded',
      selectionHash,
      exclusionRegistryHash,
      selectedFileCount: selectedFiles.length,
      provenance: plannerProvenance,
      perFileTimings: Object.fromEntries(selectedFiles.map((file, index) => [file, index + 1])),
    };
    const timing = timingMapFromSummary({ summary, manifest, provenance: plannerProvenance });

    assert.deepEqual(timing.timingByFile, summary.perFileTimings);
    assert.equal(timing.timingSource.artifactFingerprint, publicTestArtifactFingerprint(summary));
    assert.throws(
      () =>
        timingMapFromSummary({
          summary: { ...summary, provenance: { ...plannerProvenance, pnpmVersion: '10.0.1' } },
          manifest,
          provenance: plannerProvenance,
        }),
      /provenance does not match/,
    );
  });
});
