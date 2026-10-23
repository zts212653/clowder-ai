import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planPublicTestShards } from '../scripts/plan-public-test-shards.mjs';
import { publicTestSelectionHash } from '../scripts/resolve-public-test-files.mjs';
import {
  selectPublicTestReportArtifacts,
  writeSelectedPublicTestReports,
} from '../scripts/select-public-test-reports.mjs';
import { summarizePublicTestShardReports } from '../scripts/summarize-public-test-shards.mjs';

const sha = 'a'.repeat(40);
const files = ['test/isolated.test.js'];
const provenance = {
  workspaceTree: 'b'.repeat(40),
  lockfileHash: 'c'.repeat(64),
  nodeVersion: 'v24.20.0',
  pnpmVersion: '9.15.4',
  platform: 'linux',
  arch: 'x64',
};
const plan = planPublicTestShards({
  selectedFiles: files,
  selectionHash: publicTestSelectionHash(files),
  exclusionRegistryHash: 'd'.repeat(64),
  plannerProvenance: provenance,
  classification: {
    version: 2,
    sharedResources: [],
    defaultIsolationEvidence: {
      kind: 'kernel-no-egress-plus-runtime-guard',
      rulesVersion: 'fixture',
      source: 'fixture',
    },
  },
});
const lanes = [plan.sharedSerialLane, ...plan.distributableShards];
const artifactName = (lane, attempt, commit = sha) => `public-test-report-${commit}-${lane}-attempt-${attempt}`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'public-report-selection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactsDir = join(root, 'raw');
  mkdirSync(artifactsDir);
  const options = { plan, artifactsDir, reportsDir: join(root, 'selected'), sha, attempt: 10 };
  const seed = (lane, attempt, overrides = {}) => {
    const directory = join(artifactsDir, artifactName(lane, attempt));
    mkdirSync(directory, { recursive: true });
    const scope = lane === 'serial-shared' ? 'shared' : 'distributable';
    const report = {
      schemaVersion: 2,
      kind: 'public_test_shard_run',
      lane,
      status: 'succeeded',
      planFingerprint: plan.planFingerprint,
      selectionHash: plan.selectionHash,
      exclusionRegistryHash: plan.exclusionRegistryHash,
      provenance,
      elapsedMs: 1,
      isolation: {
        schemaVersion: 1,
        kind: 'public_test_isolation_attestation',
        resourceScope: scope,
        boundary: 'verified',
        targetGrade: scope === 'distributable',
      },
      files:
        lanes
          .find((entry) => entry.id === lane)
          ?.files.map((file) => ({ file, status: 'passed', durationMs: 1, failureCategory: 'passed' })) ?? [],
      ...overrides,
    };
    const path = join(directory, `${lane}.json`);
    writeFileSync(path, JSON.stringify(report));
    return path;
  };
  for (const lane of lanes) seed(lane.id, 1);
  return { ...options, root, seed };
}

async function summarizeSelected(value) {
  const selected = await writeSelectedPublicTestReports(value);
  const reports = selected.map(({ lane }) => JSON.parse(readFileSync(join(value.reportsDir, `${lane}.json`), 'utf8')));
  return summarizePublicTestShardReports({ plan, reports });
}

test('new successful attempt replaces old failed evidence without overwriting either original', async (t) => {
  const value = fixture(t);
  const old = value.seed('distributable-3', 1, { status: 'failed' });
  const newer = value.seed('distributable-3', 2);
  const before = [readFileSync(old, 'utf8'), readFileSync(newer, 'utf8')];
  assert.equal((await summarizeSelected(value)).status, 'succeeded');
  assert.deepEqual([readFileSync(old, 'utf8'), readFileSync(newer, 'utf8')], before);
  const receipt = JSON.parse(readFileSync(join(value.reportsDir, 'selection.json'), 'utf8'));
  assert.equal(receipt.selections.find((entry) => entry.lane === 'distributable-3').attempt, 2);
  assert.equal(receipt.selections.find((entry) => entry.lane === 'serial-shared').attempt, 1);
});

test('latest failure remains blocking instead of selecting an older green report', async (t) => {
  const value = fixture(t);
  value.seed('distributable-3', 2, { status: 'failed' });
  await assert.rejects(summarizeSelected(value), /distributable-3 report is not green/);
  assert.equal(JSON.parse(readFileSync(join(value.reportsDir, 'distributable-3.json'))).status, 'failed');
});

test('latest attempt is numeric and independent of directory enumeration order', () => {
  const names = lanes.map(({ id }) => artifactName(id, 1));
  names.push(artifactName('distributable-3', 10), artifactName('distributable-3', 2));
  const select = (artifactDirectories) =>
    selectPublicTestReportArtifacts({ plan, artifactDirectories, sha, attempt: 10 });
  const selected = select(names);
  assert.deepEqual(select([...names].reverse()), selected);
  assert.equal(selected.find((entry) => entry.lane === 'distributable-3').attempt, 10);
});

test('a latest artifact without its report fails rather than falling back', async (t) => {
  const value = fixture(t);
  mkdirSync(join(value.artifactsDir, artifactName('distributable-3', 2)));
  await assert.rejects(writeSelectedPublicTestReports(value), /ENOENT/);
  assert.equal(existsSync(value.reportsDir), false);
});

test('malformed latest JSON and basic payload mismatches cannot fall back', async (t) => {
  for (const kind of ['json', 'schema', 'kind', 'lane', 'fingerprint']) {
    const value = fixture(t);
    const changes = {
      schema: { schemaVersion: 1 },
      kind: { kind: 'other' },
      lane: { lane: 'distributable-2' },
      fingerprint: { planFingerprint: 'e'.repeat(64) },
    };
    const latest = value.seed('distributable-3', 2, changes[kind]);
    if (kind === 'json') writeFileSync(latest, '{broken');
    await assert.rejects(writeSelectedPublicTestReports(value));
    assert.equal(existsSync(value.reportsDir), false);
  }
});

test('latest provenance, coverage, selection and isolation remain subject to the original summary guards', async (t) => {
  for (const overrides of [
    { provenance: { ...provenance, workspaceTree: 'e'.repeat(40) } },
    { files: [{ file: 'test/unplanned.test.js', status: 'passed', durationMs: 1, failureCategory: 'passed' }] },
    { selectionHash: 'e'.repeat(64) },
    { isolation: undefined },
  ]) {
    const value = fixture(t);
    value.seed('distributable-3', 2, overrides);
    await assert.rejects(summarizeSelected(value));
    const selected = JSON.parse(readFileSync(join(value.reportsDir, 'selection.json')));
    assert.equal(selected.selections.find((entry) => entry.lane === 'distributable-3').attempt, 2);
  }
});

test('missing lanes, legacy names, unknown lanes, wrong commits and future attempts are rejected', () => {
  const baseline = lanes.map(({ id }) => artifactName(id, 1));
  for (const extra of [
    `public-test-report-${sha}-distributable-3`,
    artifactName('distributable-7', 2),
    artifactName('distributable-3', 2, 'e'.repeat(40)),
    artifactName('distributable-3', 11),
    artifactName('distributable-3', '01'),
    artifactName('distributable-3', '9007199254740992'),
  ]) {
    assert.throws(() =>
      selectPublicTestReportArtifacts({ plan, artifactDirectories: [...baseline, extra], sha, attempt: 10 }),
    );
  }
  assert.throws(
    () => selectPublicTestReportArtifacts({ plan, artifactDirectories: baseline.slice(1), sha, attempt: 10 }),
    /missing/,
  );
});

test('selection refuses an existing output directory and leaves its contents untouched', async (t) => {
  const value = fixture(t);
  mkdirSync(value.reportsDir);
  const history = join(value.reportsDir, 'keep.txt');
  writeFileSync(history, 'keep');
  await assert.rejects(writeSelectedPublicTestReports(value), /EEXIST/);
  assert.equal(readFileSync(history, 'utf8'), 'keep');
});

test('selection cannot write inside original artifacts using a dot-prefixed directory', async (t) => {
  const value = fixture(t);
  await assert.rejects(
    writeSelectedPublicTestReports({ ...value, reportsDir: join(value.artifactsDir, '..selected') }),
    /outside original artifacts/,
  );
});

test('the actual selector CLI emits a unique lane set accepted by the unchanged summary CLI', (t) => {
  const value = fixture(t);
  value.seed('distributable-3', 1, { status: 'failed' });
  value.seed('distributable-3', 2);
  const planPath = join(value.root, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan));
  const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
  const output = execFileSync(
    process.execPath,
    [
      resolve(scripts, 'select-public-test-reports.mjs'),
      '--plan',
      planPath,
      '--artifacts-dir',
      value.artifactsDir,
      '--reports-dir',
      value.reportsDir,
      '--sha',
      sha,
      '--attempt',
      '10',
    ],
    { encoding: 'utf8' },
  );
  assert.match(output, /distributable-3.*attempt=2/);
  const summaryPath = join(value.root, 'summary.json');
  execFileSync(process.execPath, [
    resolve(scripts, 'summarize-public-test-shards.mjs'),
    '--plan',
    planPath,
    '--reports-dir',
    value.reportsDir,
    '--output',
    summaryPath,
  ]);
  assert.equal(JSON.parse(readFileSync(summaryPath)).status, 'succeeded');
});
