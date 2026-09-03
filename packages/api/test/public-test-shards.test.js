import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  auditPublicTestIsolation,
  planPublicTestShards,
  validatePublicTestShardPlan,
} from '../scripts/plan-public-test-shards.mjs';
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
];

const classification = {
  version: 1,
  rules: [
    {
      id: 'redis-state',
      match: '^test/redis-state\\.test\\.js$',
      lane: 'serial',
      reason: 'shared Redis lifecycle',
    },
    {
      id: 'watch-state',
      match: '^test/fs-watch-state\\.test\\.js$',
      lane: 'serial',
      reason: 'filesystem watcher lifecycle',
    },
    {
      id: 'pure-contracts',
      match: '^test/pure-',
      lane: 'pure',
      isolationEvidence: {
        kind: 'static-negative-scan',
        rulesVersion: 'f308-v1',
        source: 'test fixture has no Redis, port, process, watcher, or mutable shared-store use',
      },
    },
  ],
};

const isolationAuditByFile = Object.fromEntries(
  selectedFiles
    .filter((file) => file.startsWith('test/pure-'))
    .map((file) => [
      file,
      {
        ok: true,
        evidence: {
          kind: 'static-negative-scan',
          rulesVersion: 'f308-v1',
          source: `fixture:${file}`,
        },
      },
    ]),
);

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

const temporaryRoots = [];

function temporaryPackageRoot() {
  const root = mkdtempSync(join(tmpdir(), 'cc-f308-public-test-audit-'));
  temporaryRoots.push(root);
  mkdirSync(join(root, 'test'), { recursive: true });
  return root;
}

describe('F308 public-test sharding', () => {
  it('assigns every selected file exactly once, preserving stateful files in the serial lane', () => {
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
      isolationAuditByFile,
      shardCount: 4,
    });

    assert.equal(plan.schemaVersion, 1);
    assert.deepEqual(plan.lanes.serial.files.sort(), ['test/fs-watch-state.test.js', 'test/redis-state.test.js']);
    assert.equal(plan.pureShards.length, 4);
    assert.doesNotThrow(() => validatePublicTestShardPlan(plan, selectedFiles));

    const assigned = [...plan.lanes.serial.files, ...plan.pureShards.flatMap((shard) => shard.files)].sort();
    assert.deepEqual(assigned, [...selectedFiles].sort());
  });

  it('is reproducible when input order changes and uses duration balancing deterministically', () => {
    const options = {
      selectionHash,
      exclusionRegistryHash,
      classification,
      plannerProvenance,
      timingByFile: Object.fromEntries(selectedFiles.map((file, index) => [file, 50 - index])),
      isolationAuditByFile,
      shardCount: 4,
    };
    const first = planPublicTestShards({ ...options, selectedFiles });
    const second = planPublicTestShards({ ...options, selectedFiles: [...selectedFiles].reverse() });

    assert.deepEqual(first, second);
    assert.deepEqual(
      first.pureShards.map((shard) => shard.estimatedDurationMs),
      [...first.pureShards.map((shard) => shard.estimatedDurationMs)].sort((a, b) => a - b),
    );
  });

  it('uses locale-independent path ordering for deterministic shard ids', () => {
    const files = ['test/pure-z.test.js', 'test/pure-ä.test.js', 'test/pure-a.test.js', 'test/pure-b.test.js'];
    const audit = Object.fromEntries(files.map((file) => [file, { ok: true, evidence: { kind: 'fixture' } }]));
    const plan = planPublicTestShards({
      selectedFiles: files,
      selectionHash: publicTestSelectionHash(files),
      exclusionRegistryHash,
      classification,
      plannerProvenance,
      isolationAuditByFile: audit,
      shardCount: 4,
    });

    assert.deepEqual(
      plan.pureShards.map((shard) => shard.files[0]),
      ['test/pure-a.test.js', 'test/pure-b.test.js', 'test/pure-z.test.js', 'test/pure-ä.test.js'],
    );
  });

  it('fails closed for unproven pure classification and duplicate/missing assignment', () => {
    assert.throws(
      () =>
        planPublicTestShards({
          selectedFiles: ['test/pure-alpha.test.js'],
          selectionHash: publicTestSelectionHash(['test/pure-alpha.test.js']),
          exclusionRegistryHash,
          classification: { version: 1, rules: [{ id: 'unsafe', match: '.*', lane: 'pure' }] },
          plannerProvenance,
          shardCount: 4,
        }),
      /isolationEvidence/,
    );

    const plan = planPublicTestShards({
      selectedFiles,
      selectionHash,
      exclusionRegistryHash,
      classification,
      plannerProvenance,
      isolationAuditByFile,
      shardCount: 4,
    });
    plan.pureShards[0].files.push('test/redis-state.test.js');
    assert.throws(() => validatePublicTestShardPlan(plan, selectedFiles), /exactly once/);
  });

  it('demotes nominally pure tests without a current isolation audit to the serial lane', () => {
    const plan = planPublicTestShards({
      selectedFiles,
      selectionHash,
      exclusionRegistryHash,
      classification,
      plannerProvenance,
      isolationAuditByFile: {},
      shardCount: 4,
    });

    assert.deepEqual(plan.lanes.serial.files, [...selectedFiles].sort());
    assert.equal(plan.pureShards.flatMap((shard) => shard.files).length, 0);
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

  it('keeps stateful and dynamic module-loading source markers out of pure shards', async () => {
    const packageRoot = temporaryPackageRoot();
    const markedFiles = {
      'test/redis-contract.test.js': 'const redis = process.env.REDIS_URL;\n',
      'test/port-contract.test.js': 'server.listen(0);\n',
      'test/watch-contract.test.js': 'fs.watch(".", () => {});\n',
      'test/write-contract.test.js': 'writeFile("x", "y");\n',
      'test/process-contract.test.js': 'spawn("node", []);\n',
      'test/worker-contract.test.js': 'new Worker("worker.js");\n',
      'test/network-contract.test.js': 'await fetch("https://example.invalid");\n',
      'test/dynamic-load-contract.test.js': 'const name = "./stateful.js"; await import(name);\n',
      'test/computed-require-contract.test.js': 'const name = "./stateful.cjs"; require(name);\n',
      'test/isolated-contract.test.js': 'assert.equal(1 + 1, 2);\n',
    };
    for (const [file, source] of Object.entries(markedFiles)) writeFileSync(join(packageRoot, file), source);
    const files = Object.keys(markedFiles).sort();
    const audit = await auditPublicTestIsolation({ selectedFiles: files, packageRoot });
    for (const file of files.filter((file) => file !== 'test/isolated-contract.test.js')) {
      assert.equal(audit[file].ok, false, file);
    }
    assert.equal(audit['test/isolated-contract.test.js'].ok, true);
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  });
});
