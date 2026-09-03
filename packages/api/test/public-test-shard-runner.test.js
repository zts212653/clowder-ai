import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { currentPublicTestProvenance } from '../scripts/public-test-provenance.mjs';
import { publicTestSelectionHash } from '../scripts/resolve-public-test-files.mjs';
import {
  categorizePublicTestFailure,
  filesForPublicTestLane,
  runPublicTestLane,
} from '../scripts/run-public-test-shard.mjs';

const selectedFiles = ['test/pure-alpha.test.js', 'test/pure-beta.test.js', 'test/serial-redis.test.js'];
const manifest = {
  schemaVersion: 1,
  selectedFiles,
  excludedFiles: [],
  selectionHash: publicTestSelectionHash(selectedFiles),
  exclusionRegistryHash: 'e'.repeat(64),
};
const plannerProvenance = currentPublicTestProvenance(process.cwd());
const plan = {
  schemaVersion: 1,
  selectedFiles,
  selectionHash: manifest.selectionHash,
  exclusionRegistryHash: manifest.exclusionRegistryHash,
  classificationVersion: 1,
  plannerProvenance,
  timingSource: { kind: 'unmeasured_default', estimatedDurationMs: 1_000 },
  lanes: { serial: { files: ['test/serial-redis.test.js'], estimatedDurationMs: 10 } },
  pureShards: [
    { id: 'pure-1', files: ['test/pure-alpha.test.js'], estimatedDurationMs: 5 },
    { id: 'pure-2', files: ['test/pure-beta.test.js'], estimatedDurationMs: 4 },
    { id: 'pure-3', files: [], estimatedDurationMs: 0 },
    { id: 'pure-4', files: [], estimatedDurationMs: 0 },
  ],
  assignments: {
    'test/pure-alpha.test.js': { lane: 'pure-1', ruleId: 'pure', estimatedDurationMs: 5 },
    'test/pure-beta.test.js': { lane: 'pure-2', ruleId: 'pure', estimatedDurationMs: 4 },
    'test/serial-redis.test.js': { lane: 'serial', ruleId: 'stateful', estimatedDurationMs: 10 },
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

describe('F308 public-test shard runner', () => {
  it('runs each lane serially, stops at its first failure, and keeps typed per-file facts', async () => {
    const calls = [];
    const report = await runPublicTestLane({
      plan,
      lane: 'pure-1',
      packageRoot: process.cwd(),
      manifest,
      executeFile: async ({ file }) => {
        calls.push(file);
        return {
          file,
          status: 'passed',
          exitCode: 0,
          signal: null,
          durationMs: 7,
          startedAt: '2026-08-27T00:00:00.000Z',
          finishedAt: '2026-08-27T00:00:00.007Z',
          outputHash: 'a'.repeat(64),
          failureCategory: 'passed',
        };
      },
    });

    assert.deepEqual(calls, ['test/pure-alpha.test.js']);
    assert.equal(report.status, 'succeeded');
    assert.equal(report.files[0].durationMs, 7);
    assert.equal(report.provenance.workspaceTree.length, 40);
    assert.equal(report.provenance.lockfileHash.length, 64);
    assert.equal(report.provenance.pnpmVersion.length > 0, true);
    assert.equal(report.plannedFileCount, 1);
  });

  it('does not run a later file after the first hard failure', async () => {
    const twoFilePlan = structuredClone(plan);
    twoFilePlan.pureShards[0].files = ['test/pure-alpha.test.js', 'test/pure-beta.test.js'];
    twoFilePlan.pureShards[1].files = [];
    twoFilePlan.assignments['test/pure-beta.test.js'].lane = 'pure-1';
    const unsigned = { ...twoFilePlan };
    delete unsigned.planFingerprint;
    twoFilePlan.planFingerprint = createHash('sha256')
      .update(JSON.stringify(stable(unsigned)))
      .digest('hex');
    const calls = [];
    const report = await runPublicTestLane({
      plan: twoFilePlan,
      lane: 'pure-1',
      packageRoot: process.cwd(),
      manifest,
      executeFile: async ({ file }) => {
        calls.push(file);
        return {
          file,
          status: 'failed',
          exitCode: 1,
          signal: null,
          durationMs: 8,
          startedAt: '2026-08-27T00:00:00.000Z',
          finishedAt: '2026-08-27T00:00:00.008Z',
          outputHash: 'b'.repeat(64),
          failureCategory: 'test_failure',
        };
      },
    });

    assert.deepEqual(calls, ['test/pure-alpha.test.js']);
    assert.equal(report.status, 'failed');
    assert.equal(report.firstHardFailure.code, 'test_failure');
  });

  it('rejects a manifest or lane that cannot prove exact selected-file provenance', async () => {
    assert.throws(() => filesForPublicTestLane(plan, 'pure-9'), /unknown public-test shard lane/);
    await assert.rejects(
      runPublicTestLane({
        plan,
        lane: 'pure-1',
        packageRoot: process.cwd(),
        manifest: { ...manifest, exclusionRegistryHash: 'd'.repeat(64) },
      }),
      /exclusion registry/,
    );
  });

  it('keeps state, port, resource, and generic failures distinguishable', () => {
    assert.equal(categorizePublicTestFailure({ exitCode: 1, output: 'Error: EADDRINUSE' }), 'state_or_port_failure');
    assert.equal(categorizePublicTestFailure({ exitCode: 1, output: 'heap out of memory' }), 'resource_exhaustion');
    assert.equal(categorizePublicTestFailure({ exitCode: 1, output: 'plain assertion' }), 'test_failure');
  });
});
