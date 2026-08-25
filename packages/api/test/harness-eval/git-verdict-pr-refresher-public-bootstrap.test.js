import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { createGitVerdictPrRefresher } from '../../dist/infrastructure/harness-eval/publish-verdict/git-verdict-pr-refresher.js';

const verdictId = 'public-first-verdict';
const branchName = `verdict/auto/eval-a2a/${verdictId}`;
const censusPath = 'docs/harness-feedback/registry/measurement-bundles.yaml';

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(repo, path, content) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function createFirstVerdictRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'public-first-refresh-repo-'));
  const remote = mkdtempSync(join(tmpdir(), 'public-first-refresh-remote-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test User');
  const hooksDir = join(repo, '.githooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'pre-push'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(hooksDir, 'pre-push'), 0o755);
  git(repo, 'config', 'core.hooksPath', '.githooks');
  write(repo, 'README.md', '# public clone\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init without instance census');
  git(remote, 'init', '--bare');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-u', 'origin', 'main');

  git(repo, 'switch', '-c', branchName);
  write(repo, `docs/harness-feedback/verdicts/${verdictId}.md`, '# first verdict\n');
  write(repo, censusPath, 'instance: public\ncount: 1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'publish first verdict with instance census');
  git(repo, 'push', '-u', 'origin', branchName);
  const branchHead = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'switch', 'main');
  write(repo, 'CHANGELOG.md', 'new source sync\n');
  git(repo, 'add', 'CHANGELOG.md');
  git(repo, 'commit', '-m', 'advance public main without census');
  git(repo, 'push', 'origin', 'main');
  return { branchHead, remote, repo };
}

describe('git verdict PR refresher public bootstrap', () => {
  it('refreshes a first-verdict branch when public main still has no census', async () => {
    const { branchHead, remote, repo } = createFirstVerdictRepo();
    try {
      const refresh = createGitVerdictPrRefresher({
        repoRoot: repo,
        expectedRepoFullName: 'zts212653/clowder-ai',
        identityRunner: async () => {},
        resolveOpenPr: async () => [
          {
            url: 'https://github.com/zts212653/clowder-ai/pull/9999',
            headRefOid: branchHead,
            headRefName: branchName,
            baseRefName: 'main',
            body: 'Verdict published via cat_cafe_publish_verdict MCP tool.',
          },
        ],
      });

      const result = await refresh({
        branchName,
        verdictId,
        expectedHeadSha: branchHead,
        generatedAt: '2026-08-24T00:00:00.000Z',
        refreshDerivedCensus(worktreeRoot, _generatedAt, cleanSource) {
          assert.equal(cleanSource, 'instance: public\ncount: 1\n');
          writeFileSync(join(worktreeRoot, censusPath), 'instance: public\ncount: 2\n');
          return join(worktreeRoot, censusPath);
        },
      });

      assert.equal(result.outcome, 'updated');
      assert.equal(git(remote, 'show', `${result.commitSha}:${censusPath}`), 'instance: public\ncount: 2');
      assert.equal(readFileSync(join(repo, '.githooks/pre-push'), 'utf8'), '#!/bin/sh\nexit 0\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });
});
