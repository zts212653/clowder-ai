import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const guardPath = fileURLToPath(new URL('./gh', import.meta.url));

const baseCensus = `kind: f267-measurement-bundle-census
schemaVersion: 2
entries:
  - domainId: eval:existing
    classification: active_decision_bearing
    enabled: true
    committedVerdictArtifactCount: 0
    validityMigration:
      riskRank: 1
      batch: null
      status: unmigrated
      certificateRef: null
      resultRef: null
      replayRef: null
      actionGate: keep_observe_only
      hardBlockReason: Existing domain is not certified.
`;

const safeBootstrapEntry = `  - domainId: eval:harness-ledger
    classification: active_decision_bearing
    enabled: true
    committedVerdictArtifactCount: 0
    validityMigration:
      riskRank: 2
      batch: null
      status: unmigrated
      certificateRef: null
      resultRef: null
      replayRef: null
      actionGate: keep_observe_only
      hardBlockReason: This domain is not certified.
`;

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function write(repo, relativePath, content) {
  const path = join(repo, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function commit(repo, message = 'test change') {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', message);
}

function setupRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'guarded-gh-census-'));
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  const delegate = join(root, 'fake-gh.mjs');
  t.after(() => rmSync(root, { force: true, recursive: true }));

  git(root, 'init', '--bare', origin);
  git(root, 'init', repo);
  git(repo, 'config', 'user.email', 'guard-test@example.invalid');
  git(repo, 'config', 'user.name', 'Guard Test');
  write(repo, 'docs/harness-feedback/registry/measurement-bundles.yaml', baseCensus);
  commit(repo, 'base');
  git(repo, 'branch', '-M', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-u', 'origin', 'main');
  git(repo, 'switch', '-c', 'feature');

  writeFileSync(delegate, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(delegate, 0o755);
  return { repo, delegate };
}

function runGuard(repo, delegate, args = ['pr', 'create', '--base', 'main', '--title', 'feat: test']) {
  return spawnSync(process.execPath, [guardPath, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CAT_CAFE_REAL_GH_PATH: delegate },
  });
}

function addBootstrap(repo, entry = safeBootstrapEntry) {
  const path = join(repo, 'docs/harness-feedback/registry/measurement-bundles.yaml');
  writeFileSync(path, `${readFileSync(path, 'utf8')}${entry}`);
  commit(repo);
}

test('allows a pure fail-closed census bootstrap and delegates exact gh arguments', (t) => {
  const { repo, delegate } = setupRepo(t);
  addBootstrap(repo);

  const args = ['pr', 'create', '--repo', 'mindfn/clowder-ai', '--base', 'main', '--title', 'feat: test'];
  const result = runGuard(repo, delegate, args);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('rejects any modification to an existing census entry', (t) => {
  const { repo, delegate } = setupRepo(t);
  const path = join(repo, 'docs/harness-feedback/registry/measurement-bundles.yaml');
  writeFileSync(path, baseCensus.replace('enabled: true', 'enabled: false'));
  commit(repo);

  const result = runGuard(repo, delegate);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^verdict_census_bootstrap_only:/);
});

for (const [name, mutate] of [
  [
    'nonzero committed artifact count',
    (entry) => entry.replace('committedVerdictArtifactCount: 0', 'committedVerdictArtifactCount: 1'),
  ],
  ['certificate reference', (entry) => entry.replace('certificateRef: null', 'certificateRef: artifact:certificate')],
  ['result reference', (entry) => entry.replace('resultRef: null', 'resultRef: artifact:result')],
  ['replay reference', (entry) => entry.replace('replayRef: null', 'replayRef: artifact:replay')],
  [
    'non-bootstrap action gate',
    (entry) => entry.replace('actionGate: keep_observe_only', 'actionGate: certificate_actions_allowed'),
  ],
]) {
  test(`rejects a new census entry with ${name}`, (t) => {
    const { repo, delegate } = setupRepo(t);
    addBootstrap(repo, mutate(safeBootstrapEntry));

    const result = runGuard(repo, delegate);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^verdict_census_bootstrap_only:/);
  });
}

test('rejects additions outside a new top-level census entry', (t) => {
  const { repo, delegate } = setupRepo(t);
  const path = join(repo, 'docs/harness-feedback/registry/measurement-bundles.yaml');
  writeFileSync(path, `${baseCensus}notes: not-an-entry\n${safeBootstrapEntry}`);
  commit(repo);

  const result = runGuard(repo, delegate);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^verdict_census_bootstrap_only:/);
});

test('still retires Git publication when a verdict bundle is added with a safe census entry', (t) => {
  const { repo, delegate } = setupRepo(t);
  const censusPath = join(repo, 'docs/harness-feedback/registry/measurement-bundles.yaml');
  writeFileSync(censusPath, `${baseCensus}${safeBootstrapEntry}`);
  write(repo, 'docs/harness-feedback/bundles/example/verdict.md', '# runtime verdict\n');
  commit(repo);

  const result = runGuard(repo, delegate);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^verdict_git_publication_retired:/);
});

test('does not inspect census changes for non-PR-create commands', (t) => {
  const { repo, delegate } = setupRepo(t);
  const path = join(repo, 'docs/harness-feedback/registry/measurement-bundles.yaml');
  writeFileSync(path, baseCensus.replace('enabled: true', 'enabled: false'));
  commit(repo);
  const args = ['issue', 'list', '--repo', 'mindfn/clowder-ai'];

  const result = runGuard(repo, delegate, args);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});
