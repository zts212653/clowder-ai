// @ts-check

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const roots = [];
const EXPECTED_REPO = 'zts212653/cat-cafe';

function git(root, args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options }).trim();
}

function createRepoWithOrigin() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'publisher-contract-repo-'));
  const remoteRoot = mkdtempSync(join(tmpdir(), 'publisher-contract-remote-'));
  roots.push(repoRoot, remoteRoot);
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  writeFileSync(join(repoRoot, 'README.md'), '# fixture\n');
  mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
  writeFileSync(join(repoRoot, 'scripts/check-verdict-publish-contract.mjs'), '// fixture\n');
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-m', 'seed']);
  execFileSync('git', ['init', '--bare', remoteRoot], { stdio: 'ignore' });
  git(repoRoot, ['remote', 'add', 'origin', remoteRoot]);
  git(repoRoot, ['push', '-u', 'origin', 'main']);
  git(repoRoot, ['fetch', 'origin', 'main']);
  return { repoRoot, remoteRoot };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('GitWorktreePublisher target/corpus contract', () => {
  it('uses explicit gh repository scope for every GitHub command', async () => {
    const { withGitHubRepoScope } = await import(
      '../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js'
    );
    assert.deepEqual(withGitHubRepoScope(['pr', 'create', '--base', 'main'], EXPECTED_REPO), [
      'pr',
      'create',
      '--base',
      'main',
      '--repo',
      EXPECTED_REPO,
    ]);
  });

  it('runs candidate contract validation after commit and before any push', async () => {
    const { repoRoot, remoteRoot } = createRepoWithOrigin();
    const checks = [];
    const { createGitWorktreePublisher } = await import(
      `../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js?t=${Date.now()}`
    );
    const publisher = createGitWorktreePublisher({
      repoRoot,
      expectedRepoFullName: EXPECTED_REPO,
      contractRunner: async (input) => {
        checks.push(input);
        if (input.sourceRef === 'HEAD') {
          assert.match(git(input.repoRoot, ['log', '-1', '--format=%s']), /^verdict\(test\):/);
          throw new Error('verdict_window_already_published: canonical packet already owns this window');
        }
      },
    });
    const branchName = 'verdict/auto/eval-friction/conflicting-window';

    await assert.rejects(
      publisher.publishOnIsolatedWorktree({
        branchName,
        sourceBase: 'origin/main',
        stage: async (worktreePath) => {
          const verdictPath = join(worktreePath, 'docs/harness-feedback/verdicts/conflicting-window.md');
          mkdirSync(dirname(verdictPath), { recursive: true });
          writeFileSync(verdictPath, '# conflict\n');
          return {
            paths: [verdictPath],
            commitMessage: 'verdict(test): conflicting window',
            prTitle: 'should not publish',
            prBody: 'should not publish',
          };
        },
      }),
      /verdict_window_already_published/,
    );

    assert.equal(checks.at(-1)?.sourceRef, 'HEAD');
    assert.equal(checks.at(-1)?.baseRef, 'origin/main');
    assert.equal(checks[0]?.identityOnly, true);
    assert.equal(checks[1]?.identityOnly, undefined);
    assert.throws(
      () => git(remoteRoot, ['rev-parse', '--verify', `refs/heads/${branchName}`]),
      /unknown revision|Needed a single revision|ambiguous argument/,
      'candidate rejected by the contract must never reach origin',
    );
  });
});
