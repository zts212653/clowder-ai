import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, describe, it } from 'node:test';

const WRAPPER = resolve(import.meta.dirname, 'gh');
// Guard scripts live at the project root (CAT_CAFE_VERDICT_GH_GUARD_ROOT)
const GUARD_ROOT = resolve(import.meta.dirname, '../..');
const EXPECTED_REPO = 'zts212653/clowder-ai';

function makeVerdictRepo({ seedEvidence = false } = {}) {
  const dir = mkdtempSync(`${tmpdir()}/gh-wrapper-test-`);
  execSync('git init --initial-branch=main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "test" && git config user.email "test@test"', { cwd: dir, stdio: 'pipe' });
  execSync(`git remote add origin https://github.com/${EXPECTED_REPO}.git`, { cwd: dir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: 'pipe' });
  // Create fake origin/main for transport guard base-ref resolution
  execSync('git update-ref refs/remotes/origin/main HEAD', { cwd: dir, stdio: 'pipe' });
  if (seedEvidence) {
    const bundleDir = resolve(dir, 'docs/harness-feedback/bundles/test-2026');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      resolve(bundleDir, 'lifecycle-root.json'),
      JSON.stringify({
        schemaVersion: 1,
        verdictId: 'test-2026',
        domainId: 'eval:a2a',
        createdAt: '2026-01-01T00:00:00.000Z',
        verdict: 'keep_observe',
        harnessUnderEval: { featureId: 'F1', componentId: 'C1', name: 'test' },
        ownerAsk: { targetFeatureId: 'F1', targetOwnerCatId: 'opus', requestedAction: 'observe' },
        acceptanceReevalPlan: { nextEvalAt: '2026-02-01T00:00:00.000Z', closureCondition: 'stable' },
      }),
    );
    writeFileSync(
      resolve(bundleDir, 'snapshot.json'),
      JSON.stringify({
        window: { startMs: 1000, endMs: 2000, durationHours: 0.28 },
      }),
    );
    writeFileSync(
      resolve(bundleDir, 'provenance.json'),
      JSON.stringify({
        generatedBy: 'test',
        generatedAt: '2026-01-01',
      }),
    );
    const censusDir = resolve(dir, 'docs/harness-feedback/registry');
    mkdirSync(censusDir, { recursive: true });
    writeFileSync(resolve(censusDir, 'measurement-bundles.yaml'), 'entries: []\n');
    execSync('git add -A && git commit -m "seed evidence"', { cwd: dir, stdio: 'pipe' });
  }
  return dir;
}

function runWrapper(repoDir, ghArgs) {
  return execFileSync(process.execPath, [WRAPPER, ...ghArgs], {
    encoding: 'utf8',
    timeout: 30_000,
    cwd: repoDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CAT_CAFE_VERDICT_GH_GUARD_ROOT: GUARD_ROOT,
      CAT_CAFE_REAL_GH_PATH: '/usr/bin/true',
      CAT_CAFE_VERDICT_REPO_FULL_NAME: EXPECTED_REPO,
      CAT_CAFE_REPO_FULL_NAME: EXPECTED_REPO,
    },
  });
}

function runWrapperExpectFail(repoDir, ghArgs) {
  try {
    runWrapper(repoDir, ghArgs);
    assert.fail('expected non-zero exit');
  } catch (err) {
    return err.stderr?.trim() ?? '';
  }
}

const dirs = [];
function tracked(dir) {
  dirs.push(dir);
  return dir;
}

describe('guarded-bin/gh wrapper', () => {
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('passes through non-verdict commands without guards', () => {
    const dir = tracked(makeVerdictRepo());
    runWrapper(dir, ['issue', 'list', '--repo', EXPECTED_REPO]);
  });

  it('runs both guards for verdict pr create with clean evidence', () => {
    const dir = tracked(makeVerdictRepo({ seedEvidence: true }));
    runWrapper(dir, ['pr', 'create', '--repo', EXPECTED_REPO, '--title', 'verdict(eval:a2a): test', '--base', 'main']);
  });

  it('rejects dirty evidence files (working-tree overlay)', () => {
    const dir = tracked(makeVerdictRepo({ seedEvidence: true }));
    // Dirty a committed evidence file without staging
    writeFileSync(resolve(dir, 'docs/harness-feedback/bundles/test-2026/snapshot.json'), '{bad overlay}');
    const stderr = runWrapperExpectFail(dir, [
      'pr',
      'create',
      '--repo',
      EXPECTED_REPO,
      '--title',
      'verdict(eval:a2a): test',
      '--base',
      'main',
    ]);
    assert.match(stderr, /verdict_publish_dirty_evidence/);
  });

  it('rejects --head that does not match local HEAD', () => {
    const dir = tracked(makeVerdictRepo({ seedEvidence: true }));
    execSync('git checkout -b verdict/auto/test', { cwd: dir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "verdict"', { cwd: dir, stdio: 'pipe' });
    execSync('git checkout main', { cwd: dir, stdio: 'pipe' });
    const stderr = runWrapperExpectFail(dir, [
      'pr',
      'create',
      '--repo',
      EXPECTED_REPO,
      '--title',
      'verdict(eval:a2a): test',
      '--head',
      'verdict/auto/test',
      '--base',
      'main',
    ]);
    assert.match(stderr, /verdict_publish_head_mismatch/);
  });

  it('fails evidence guard on committed malformed lifecycle-root (proves both guards run)', () => {
    const dir = tracked(makeVerdictRepo());
    // Seed committed evidence with mismatched verdictId: transport passes, evidence fails
    const bundleDir = resolve(dir, 'docs/harness-feedback/bundles/malformed-2026');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      resolve(bundleDir, 'lifecycle-root.json'),
      JSON.stringify({
        schemaVersion: 1,
        verdictId: 'WRONG-ID',
        domainId: 'eval:a2a',
        createdAt: '2026-01-01T00:00:00.000Z',
        verdict: 'keep_observe',
        harnessUnderEval: { featureId: 'F1', componentId: 'C1', name: 'test' },
        ownerAsk: { targetFeatureId: 'F1', targetOwnerCatId: 'opus', requestedAction: 'observe' },
        acceptanceReevalPlan: { nextEvalAt: '2026-02-01T00:00:00.000Z', closureCondition: 'stable' },
      }),
    );
    writeFileSync(resolve(bundleDir, 'snapshot.json'), JSON.stringify({ window: { startMs: 1, endMs: 2 } }));
    writeFileSync(resolve(bundleDir, 'provenance.json'), JSON.stringify({ generatedBy: 'test' }));
    const censusDir = resolve(dir, 'docs/harness-feedback/registry');
    mkdirSync(censusDir, { recursive: true });
    writeFileSync(resolve(censusDir, 'measurement-bundles.yaml'), 'entries: []\n');
    execSync('git add -A && git commit -m "malformed evidence"', { cwd: dir, stdio: 'pipe' });
    const stderr = runWrapperExpectFail(dir, [
      'pr',
      'create',
      '--repo',
      EXPECTED_REPO,
      '--title',
      'verdict(eval:a2a): test',
      '--base',
      'main',
    ]);
    assert.match(stderr, /LIFECYCLE_ROOT_IDENTITY_MISMATCH/);
  });

  it('rejects push to wrong repository', () => {
    const dir = tracked(makeVerdictRepo({ seedEvidence: true }));
    const stderr = runWrapperExpectFail(dir, [
      'pr',
      'create',
      '--repo',
      'attacker/exfil',
      '--title',
      'verdict(eval:a2a): test',
      '--base',
      'main',
    ]);
    assert.match(stderr, /verdict_publish_wrong_repository/);
  });
});
