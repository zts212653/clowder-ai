import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

function installPrePushHook(repo, script, hooksPathSetting = '.githooks') {
  const hooksDir = hooksPathSetting.startsWith('/') ? hooksPathSetting : join(repo, hooksPathSetting);
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'pre-push');
  writeFileSync(hookPath, script);
  chmodSync(hookPath, 0o755);
  git(repo, 'config', 'core.hooksPath', hooksPathSetting);
}

function installDetachedHeadGuard(repo) {
  installPrePushHook(
    repo,
    `#!/bin/sh
while read local_ref local_sha remote_ref remote_sha
do
  case "$remote_ref" in
    refs/heads/*)
      if [ "$local_ref" = "HEAD" ]; then
        echo "BLOCKED: Non-branch ref push to named branch!" >&2
        exit 1
      fi
      ;;
  esac
done
exit 0
`,
    '.githooks',
  );
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
  installDetachedHeadGuard(repo);
  git(repo, 'push', '-u', 'origin', 'main');

  git(repo, 'switch', '-c', branchName);
  write(repo, verdictPath, '# target verdict\n');
  write(repo, censusPath, 'count: 1\n');
  git(repo, 'add', verdictPath, censusPath);
  git(repo, 'commit', '-m', 'publish target verdict');
  git(repo, 'push', '-u', 'origin', branchName);
  const branchHead = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'switch', 'main');
  write(repo, 'docs/harness-feedback/verdicts/concurrent.md', '# concurrent\n');
  write(repo, censusPath, 'count: 1\nsource: main\n');
  git(repo, 'add', 'docs/harness-feedback/verdicts/concurrent.md', censusPath);
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

function dropLocalVerdictBranch(repo) {
  git(repo, 'branch', '-D', branchName);
}

function createTestRefresher(deps) {
  return createGitVerdictPrRefresher({
    expectedRepoFullName: 'zts212653/cat-cafe',
    identityRunner: async () => {},
    ...deps,
  });
}

describe('git verdict PR refresher', () => {
  it('validates the effective owner remote before resolving or fetching the PR', async () => {
    const { repo } = createDivergedVerdictRepo();
    let resolved = false;
    try {
      const refresh = createGitVerdictPrRefresher({
        repoRoot: repo,
        expectedRepoFullName: 'zts212653/cat-cafe',
        identityRunner: async () => {
          throw new Error('effective push target mismatch');
        },
        resolveOpenPr: async () => {
          resolved = true;
          return [];
        },
      });

      await assert.rejects(
        refresh({
          branchName,
          verdictId,
          expectedHeadSha: '0'.repeat(40),
          generatedAt: '2026-08-02T00:00:00.000Z',
          refreshDerivedCensus() {
            throw new Error('must not reach refresh');
          },
        }),
        /effective push target mismatch/,
      );
      assert.equal(resolved, false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('merges latest main, resolves only the derived census, and fast-forwards the same PR branch under pre-push guards', async () => {
    const { repo, remote, branchHead } = createDivergedVerdictRepo();
    try {
      const refresh = createTestRefresher({
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
      assert.equal(
        git(repo, 'rev-parse', `refs/heads/${branchName}`),
        newHead,
        'a pre-existing local branch that matches the remote head should be reused, not deleted',
      );
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
      const refresh = createTestRefresher({ repoRoot: repo, resolveOpenPr: async () => prFor(foreignHead) });
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

  it('fails closed and preserves a pre-existing local verdict branch with unpushed work', async () => {
    const { repo, remote } = createDivergedVerdictRepo();
    try {
      git(repo, 'switch', branchName);
      write(repo, 'LOCAL-ONLY.txt', 'must survive refresh\n');
      git(repo, 'add', 'LOCAL-ONLY.txt');
      git(repo, 'commit', '-m', 'local work not pushed');
      const localOnlyHead = git(repo, 'rev-parse', 'HEAD');
      const remoteHead = git(repo, 'rev-parse', `refs/remotes/origin/${branchName}`);
      git(repo, 'switch', 'main');

      const refresh = createTestRefresher({ repoRoot: repo, resolveOpenPr: async () => prFor(remoteHead) });
      await assert.rejects(
        refresh({
          branchName,
          verdictId,
          expectedHeadSha: remoteHead,
          generatedAt: '2026-08-02T00:00:00.000Z',
          refreshDerivedCensus() {
            throw new Error('must not run');
          },
        }),
        /verdict_pr_local_branch_conflict/,
      );
      assert.equal(
        git(repo, 'rev-parse', `refs/heads/${branchName}`),
        localOnlyHead,
        'refresh must not reset or delete a local branch that predates the attempt',
      );
      assert.equal(
        git(repo, 'show', `${localOnlyHead}:LOCAL-ONLY.txt`),
        'must survive refresh',
        'the preserved local branch must keep its unpushed content',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('fails closed and preserves a local verdict branch created during ownership acquisition', async () => {
    const { repo, remote } = createDivergedVerdictRepo();
    try {
      dropLocalVerdictBranch(repo);
      const remoteHead = git(repo, 'rev-parse', `refs/remotes/origin/${branchName}`);
      let concurrentHead = '';
      let injected = false;

      const refresh = createTestRefresher({
        repoRoot: repo,
        resolveOpenPr: async () => prFor(remoteHead),
        async beforeAcquireLocalBranch({ repoRoot, branchName: localBranchName }) {
          if (injected) return;
          injected = true;
          git(repoRoot, 'switch', '-c', localBranchName);
          write(repoRoot, 'RACE-LOCAL.txt', 'must survive concurrent create\n');
          git(repoRoot, 'add', 'RACE-LOCAL.txt');
          git(repoRoot, 'commit', '-m', 'concurrent local branch');
          concurrentHead = git(repoRoot, 'rev-parse', 'HEAD');
          git(repoRoot, 'switch', 'main');
        },
      });

      await assert.rejects(
        refresh({
          branchName,
          verdictId,
          expectedHeadSha: remoteHead,
          generatedAt: '2026-08-02T00:00:00.000Z',
          refreshDerivedCensus() {
            throw new Error('must not run');
          },
        }),
        /verdict_pr_local_branch_conflict/,
      );
      assert.equal(
        git(repo, 'rev-parse', `refs/heads/${branchName}`),
        concurrentHead,
        'refresh must not delete a local branch created after the ownership probe',
      );
      assert.equal(
        git(repo, 'show', `${concurrentHead}:RACE-LOCAL.txt`),
        'must survive concurrent create',
        'the concurrent local branch content must survive cleanup',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('fails closed when the acquired local verdict branch moves to a foreign head before attach', async () => {
    const { repo, remote } = createDivergedVerdictRepo();
    try {
      dropLocalVerdictBranch(repo);
      const remoteHead = git(repo, 'rev-parse', `refs/remotes/origin/${branchName}`);
      let movedHead = '';
      let injected = false;

      const refresh = createTestRefresher({
        repoRoot: repo,
        resolveOpenPr: async () => prFor(remoteHead),
        async beforeAttachLocalBranch({ repoRoot, branchName: localBranchName, branchHead }) {
          if (injected) return;
          injected = true;
          assert.equal(git(repoRoot, 'rev-parse', `refs/heads/${localBranchName}`), branchHead);
          git(repoRoot, 'switch', localBranchName);
          write(repoRoot, 'docs/ROADMAP.md', '# foreign\n');
          git(repoRoot, 'add', 'docs/ROADMAP.md');
          git(repoRoot, 'commit', '-m', 'post-cas foreign advance');
          movedHead = git(repoRoot, 'rev-parse', 'HEAD');
          git(repoRoot, 'switch', 'main');
        },
      });

      await assert.rejects(
        refresh({
          branchName,
          verdictId,
          expectedHeadSha: remoteHead,
          generatedAt: '2026-08-02T00:00:00.000Z',
          refreshDerivedCensus() {
            throw new Error('must not run');
          },
        }),
        /verdict_pr_head_mismatch/,
      );
      assert.equal(
        git(repo, 'rev-parse', `refs/heads/${branchName}`),
        movedHead,
        'refresh must not discard a local branch that moved after CAS ownership acquisition',
      );
      assert.equal(git(repo, 'show', `${movedHead}:docs/ROADMAP.md`), '# foreign');
      assert.equal(
        git(remote, 'rev-parse', `refs/heads/${branchName}`),
        remoteHead,
        'refresh must fail before pushing the foreign local ref movement',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('pushes the validated commit even if the shared local branch moves before transport', async () => {
    const { repo, remote, branchHead } = createDivergedVerdictRepo();
    try {
      let foreignHead = '';
      let validatedCommit = '';
      let injected = false;

      const refresh = createTestRefresher({
        repoRoot: repo,
        resolveOpenPr: async () => prFor(branchHead),
        async beforePreparePinnedPush({ repoRoot, worktreePath, branchName: localBranchName, commitSha }) {
          if (injected) return;
          injected = true;
          validatedCommit = commitSha;
          assert.equal(git(worktreePath, 'rev-parse', 'HEAD'), commitSha);
          write(worktreePath, 'docs/ROADMAP.md', '# foreign\n');
          git(worktreePath, 'add', 'docs/ROADMAP.md');
          git(worktreePath, 'commit', '-m', 'foreign pre-push advance');
          foreignHead = git(worktreePath, 'rev-parse', 'HEAD');
          assert.notEqual(foreignHead, commitSha);
          assert.equal(git(repoRoot, 'rev-parse', `refs/heads/${localBranchName}`), foreignHead);
        },
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

      const remoteHead = git(remote, 'rev-parse', `refs/heads/${branchName}`);
      const remoteFiles = git(remote, 'ls-tree', '-r', '--name-only', remoteHead).split('\n').filter(Boolean);
      assert.equal(result.outcome, 'updated');
      assert.equal(result.previousHeadSha, branchHead);
      assert.equal(result.commitSha, validatedCommit);
      assert.equal(remoteHead, validatedCommit, 'remote must receive the exact validated commit');
      assert.notEqual(remoteHead, foreignHead, 'the foreign local ref advance must not escape to origin');
      assert.equal(remoteFiles.includes('docs/ROADMAP.md'), false, 'remote verdict branch must exclude the raced file');
      assert.equal(
        git(repo, 'rev-parse', `refs/heads/${branchName}`),
        foreignHead,
        'the local shared branch may still move independently after validation',
      );
      assert.equal(git(repo, 'show', `${foreignHead}:docs/ROADMAP.md`), '# foreign');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('executes the source repo pre-push hook from the pinned push repo', async () => {
    const { repo, remote, branchHead } = createDivergedVerdictRepo();
    const markerPath = join(repo, 'hook-fired.txt');
    installPrePushHook(
      repo,
      `#!/bin/sh
printf 'hook fired\\n' > "${markerPath}"
echo "source repo pre-push hook fired" >&2
exit 1
`,
      '.githooks-blocking',
    );

    try {
      const refresh = createTestRefresher({
        repoRoot: repo,
        resolveOpenPr: async () => prFor(branchHead),
      });

      await assert.rejects(
        refresh({
          branchName,
          verdictId,
          expectedHeadSha: branchHead,
          generatedAt: '2026-08-02T00:00:00.000Z',
          refreshDerivedCensus(worktreeRoot, _generatedAt, cleanSource) {
            assert.equal(cleanSource, 'count: 1\nsource: main\n');
            writeFileSync(join(worktreeRoot, censusPath), 'count: 2\nsource: main\n');
            return join(worktreeRoot, censusPath);
          },
        }),
        /source repo pre-push hook fired/,
      );

      assert.equal(readFileSync(markerPath, 'utf8'), 'hook fired\n');
      assert.equal(
        git(remote, 'rev-parse', `refs/heads/${branchName}`),
        branchHead,
        'refresh must not update the remote verdict branch when the propagated hook rejects push',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('stores the source checkout root as catcafe.verdictSourceRoot in the pinned push repo', async () => {
    const { repo, remote, branchHead } = createDivergedVerdictRepo();
    const markerPath = join(repo, 'source-root.txt');
    installPrePushHook(
      repo,
      `#!/bin/sh
git config --get catcafe.verdictSourceRoot > "${markerPath}"
echo "source root hook fired" >&2
exit 1
`,
      '.githooks-blocking',
    );

    try {
      const refresh = createTestRefresher({
        repoRoot: repo,
        resolveOpenPr: async () => prFor(branchHead),
      });

      await assert.rejects(
        refresh({
          branchName,
          verdictId,
          expectedHeadSha: branchHead,
          generatedAt: '2026-08-02T00:00:00.000Z',
          refreshDerivedCensus(worktreeRoot, _generatedAt, cleanSource) {
            assert.equal(cleanSource, 'count: 1\nsource: main\n');
            writeFileSync(join(worktreeRoot, censusPath), 'count: 2\nsource: main\n');
            return join(worktreeRoot, censusPath);
          },
        }),
        /source root hook fired/,
      );

      assert.equal(
        readFileSync(markerPath, 'utf8').trim(),
        git(repo, 'rev-parse', '--show-toplevel'),
        'pinned push repo must carry the source checkout root for the pre-push contract script lookup',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('executes the default common-dir pre-push hook when refresh runs from a linked source worktree', async () => {
    const { repo, remote, branchHead } = createDivergedVerdictRepo();
    const linkedWorktree = mkdtempSync(join(tmpdir(), 'verdict-refresh-linked-'));
    const linkedBranchName = 'linked-source-main';
    const markerPath = join(repo, 'linked-hook-fired.txt');
    rmSync(linkedWorktree, { recursive: true, force: true });
    git(repo, 'config', '--unset', 'core.hooksPath');
    const defaultHooksDir = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks');
    const sourceGitDir = git(repo, 'rev-parse', '--absolute-git-dir');
    mkdirSync(defaultHooksDir, { recursive: true });
    writeFileSync(
      join(defaultHooksDir, 'pre-push'),
      `#!/bin/sh
printf 'hook fired\\n' > "${markerPath}"
echo "linked worktree default pre-push hook fired" >&2
exit 1
`,
    );
    chmodSync(join(defaultHooksDir, 'pre-push'), 0o755);
    git(repo, 'worktree', 'add', '-b', linkedBranchName, linkedWorktree, 'main');

    try {
      const linkedGitDir = git(linkedWorktree, 'rev-parse', '--absolute-git-dir');
      const linkedEffectiveHooksDir = git(linkedWorktree, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks');
      assert.notEqual(
        resolve(linkedGitDir, 'hooks'),
        linkedEffectiveHooksDir,
        'linked worktree effective hooks directory must resolve through the common git dir, not its private admin dir',
      );
      assert.equal(
        linkedEffectiveHooksDir,
        defaultHooksDir,
        'linked worktree should observe the same default hooks directory as the source repository',
      );
      assert.notEqual(sourceGitDir, linkedGitDir);

      const refresh = createTestRefresher({
        repoRoot: linkedWorktree,
        resolveOpenPr: async () => prFor(branchHead),
      });

      await assert.rejects(
        refresh({
          branchName,
          verdictId,
          expectedHeadSha: branchHead,
          generatedAt: '2026-08-02T00:00:00.000Z',
          refreshDerivedCensus(worktreeRoot, _generatedAt, cleanSource) {
            assert.equal(cleanSource, 'count: 1\nsource: main\n');
            writeFileSync(join(worktreeRoot, censusPath), 'count: 2\nsource: main\n');
            return join(worktreeRoot, censusPath);
          },
        }),
        /linked worktree default pre-push hook fired/,
      );

      assert.equal(readFileSync(markerPath, 'utf8'), 'hook fired\n');
      assert.equal(
        git(remote, 'rev-parse', `refs/heads/${branchName}`),
        branchHead,
        'refresh must not update the remote verdict branch when the linked-worktree default hook rejects push',
      );
    } finally {
      try {
        git(repo, 'worktree', 'remove', '--force', linkedWorktree);
      } catch {
        // Best-effort cleanup for the linked test worktree.
      }
      rmSync(repo, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
      rmSync(linkedWorktree, { recursive: true, force: true });
    }
  });
});
