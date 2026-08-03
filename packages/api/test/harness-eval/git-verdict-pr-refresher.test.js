import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { createGitVerdictPrRefresher } from '../../dist/infrastructure/harness-eval/publish-verdict/git-verdict-pr-refresher.js';

const verdictId = '2026-08-02-eval-a2a-refresh';
const branchName = `verdict/auto/eval-a2a/${verdictId}`;
const censusPath = 'docs/harness-feedback/registry/measurement-bundles.yaml';
const verdictPath = `docs/harness-feedback/verdicts/${verdictId}.md`;

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(repo, path, content) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function createDivergedVerdictRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'verdict-refresh-repo-'));
  const remote = mkdtempSync(join(tmpdir(), 'verdict-refresh-remote-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test User');
  write(repo, 'README.md', '# test\n');
  write(repo, censusPath, 'count: 0\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  git(remote, 'init', '--bare');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-u', 'origin', 'main');

  git(repo, 'switch', '-c', branchName);
  write(repo, verdictPath, '# target verdict\n');
  write(repo, censusPath, 'count: 1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'publish target verdict');
  git(repo, 'push', '-u', 'origin', branchName);
  const branchHead = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'switch', 'main');
  write(repo, 'docs/harness-feedback/verdicts/concurrent.md', '# concurrent\n');
  write(repo, censusPath, 'count: 1\nsource: main\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'publish concurrent verdict');
  git(repo, 'push', 'origin', 'main');
  return { repo, remote, branchHead };
}

function prFor(headRefOid) {
  return [
    {
      url: 'https://github.com/zts212653/clowder-ai/pull/9999',
      headRefOid,
      headRefName: branchName,
      baseRefName: 'main',
      body: 'Verdict published via cat_cafe_publish_verdict MCP tool.',
    },
  ];
}

describe('git verdict PR refresher', () => {
  it('merges latest main, resolves only the derived census, and fast-forwards the same PR branch', async () => {
    const { repo, remote, branchHead } = createDivergedVerdictRepo();
    try {
      const refresh = createGitVerdictPrRefresher({
        repoRoot: repo,
        resolveOpenPr: async () => prFor(branchHead),
      });
      const result = await refresh({
        branchName,
        verdictId,
        expectedHeadSha: branchHead,
        generatedAt: '2026-08-02T00:00:00.000Z',
        refreshDerivedCensus(worktreeRoot, _generatedAt, cleanSource) {
          assert.equal(cleanSource, 'count: 1\nsource: main\n');
          writeFileSync(join(worktreeRoot, censusPath), 'count: 2\nsource: main\n');
          return join(worktreeRoot, censusPath);
        },
      });

      const newHead = git(remote, 'rev-parse', `refs/heads/${branchName}`);
      assert.equal(result.outcome, 'updated');
      assert.equal(result.previousHeadSha, branchHead);
      assert.equal(result.commitSha, newHead);
      assert.equal(git(repo, 'merge-base', '--is-ancestor', 'origin/main', newHead), '');
      assert.equal(git(repo, 'merge-base', '--is-ancestor', branchHead, newHead), '');
      assert.equal(git(remote, 'show', `${newHead}:${censusPath}`), 'count: 2\nsource: main');
      assert.equal(git(remote, 'show', `${newHead}:${verdictPath}`), '# target verdict');
      assert.equal(git(remote, 'show', `${newHead}:docs/harness-feedback/verdicts/concurrent.md`), '# concurrent');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('fails closed when the PR contains a foreign path', async () => {
    const { repo, remote, branchHead } = createDivergedVerdictRepo();
    try {
      git(repo, 'switch', branchName);
      write(repo, 'docs/ROADMAP.md', '# foreign\n');
      git(repo, 'add', 'docs/ROADMAP.md');
      git(repo, 'commit', '-m', 'foreign path');
      git(repo, 'push', 'origin', branchName);
      const foreignHead = git(repo, 'rev-parse', 'HEAD');
      const refresh = createGitVerdictPrRefresher({ repoRoot: repo, resolveOpenPr: async () => prFor(foreignHead) });
      await assert.rejects(
        refresh({
          branchName,
          verdictId,
          expectedHeadSha: foreignHead,
          generatedAt: '2026-08-02T00:00:00.000Z',
          refreshDerivedCensus() {
            throw new Error('must not run');
          },
        }),
        /verdict_pr_scope_invalid: docs\/ROADMAP\.md/,
      );
      assert.equal(git(remote, 'rev-parse', `refs/heads/${branchName}`), foreignHead);
      assert.notEqual(foreignHead, branchHead);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });
});
