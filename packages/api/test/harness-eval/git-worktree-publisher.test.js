import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

function createRepoWithOrigin() {
  const repoRoot = fs.mkdtempSync(join(tmpdir(), 'publish-wt-repo-'));
  const remoteRoot = fs.mkdtempSync(join(tmpdir(), 'publish-wt-remote-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['init', '--bare', remoteRoot], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['fetch', 'origin', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  return { repoRoot, remoteRoot };
}

function branchExists(repoRoot, branchName) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branchName}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function createTestPublisher(createGitWorktreePublisher, repoRoot) {
  return createGitWorktreePublisher({
    repoRoot,
    expectedRepoFullName: 'zts212653/cat-cafe',
    contractRunner: async () => {},
  });
}

afterEach(() => {
  syncBuiltinESMExports();
});

describe('createGitWorktreePublisher', () => {
  it('cleans up a partially-created local branch when worktree add fails before stage', async (t) => {
    const { repoRoot, remoteRoot } = createRepoWithOrigin();
    const worktreePath = fs.mkdtempSync(join(tmpdir(), 'publish-wt-target-'));
    writeFileSync(join(worktreePath, 'non-empty.txt'), 'trigger partial failure\n');
    const branchName = 'verdict/auto/eval-task-outcome/partial-fail-cleanup';

    t.mock.method(fs, 'mkdtempSync', () => worktreePath);
    syncBuiltinESMExports();

    try {
      const { createGitWorktreePublisher } = await import(
        `../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js?t=${Date.now()}`
      );
      const publisher = createTestPublisher(createGitWorktreePublisher, repoRoot);

      await assert.rejects(
        publisher.publishOnIsolatedWorktree({
          branchName,
          sourceBase: 'origin/main',
          stage: async () => {
            throw new Error('stage should not run when worktree add fails');
          },
        }),
      );

      assert.equal(
        branchExists(repoRoot, branchName),
        false,
        'partial worktree-add failure must not leak a local branch',
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(remoteRoot, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('commit step bypasses pre-commit hook so isolated worktrees without node_modules can publish (砚砚 2026-06-29/30 [爪感差])', async (t) => {
    // Regression test for 砚砚 [爪感差] root cause pinned 2026-06-30 on thread_eval_a2a:
    // `.githooks/pre-commit` runs `pnpm run check:biome-version` which needs node_modules.
    // Isolated worktrees created by this publisher never run `pnpm install`, so the hook
    // deterministically fails and surfaces as truncated 500 `git_or_gh_failed`.
    // Verdict commits are out of scope for that guard (only touch docs/harness-feedback/
    // artifacts produced by Zod-validated generator adapters), so the fix is `--no-verify`.
    const { repoRoot, remoteRoot } = createRepoWithOrigin();
    // Explicit --repo scoping lets the cleanup probe conclusively find no PR,
    // so retain the pushed ref as test evidence by making this fixture remote
    // reject the publisher's best-effort delete cleanup.
    execFileSync('git', ['config', 'receive.denyDeletes', 'true'], { cwd: remoteRoot, stdio: 'ignore' });
    // Install an always-failing pre-commit hook in the test repo. This simulates the
    // production .githooks/pre-commit failing inside the isolated worktree.
    const hooksDir = fs.mkdtempSync(join(tmpdir(), 'publish-wt-hooks-'));
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/bash\necho "pre-commit guard FAIL (simulated)" >&2\nexit 1\n');
    fs.chmodSync(hookPath, 0o755);
    execFileSync('git', ['config', 'core.hooksPath', hooksDir], { cwd: repoRoot, stdio: 'ignore' });
    // Positive control: confirm the hook DOES block a normal commit in this repo.
    writeFileSync(join(repoRoot, 'control.txt'), 'positive control\n');
    execFileSync('git', ['add', 'control.txt'], { cwd: repoRoot, stdio: 'ignore' });
    let controlBlocked = false;
    try {
      execFileSync('git', ['commit', '-m', 'should be blocked by hook'], { cwd: repoRoot, stdio: 'ignore' });
    } catch {
      controlBlocked = true;
    }
    assert.equal(controlBlocked, true, 'positive control: pre-commit hook must actually block normal commits');
    // Reset working tree from the control attempt.
    execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: repoRoot, stdio: 'ignore' });

    const branchName = 'verdict/auto/eval-a2a/no-verify-hook-bypass';
    const worktreePath = fs.mkdtempSync(join(tmpdir(), 'publish-wt-target-'));
    rmSync(worktreePath, { recursive: true, force: true }); // remove dir so worktree add can create it
    t.mock.method(fs, 'mkdtempSync', () => worktreePath);
    syncBuiltinESMExports();

    try {
      const { createGitWorktreePublisher } = await import(
        `../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js?t=${Date.now()}-noverify`
      );
      const publisher = createTestPublisher(createGitWorktreePublisher, repoRoot);

      // We expect the publisher to FAIL eventually (at `gh pr create` — there is no gh
      // configured for the bare local remote in tests). But the commit + push MUST have
      // succeeded before that point — that is what we are asserting.
      try {
        await publisher.publishOnIsolatedWorktree({
          branchName,
          sourceBase: 'origin/main',
          stage: async (wt) => {
            // Write to an allowlisted prefix (docs/harness-feedback/verdicts/) so the
            // R1 hard guard accepts the path. Writing to wt root would be rejected,
            // which is the subject of the dedicated allowlist test below.
            const verdictPath = join(wt, 'docs/harness-feedback/verdicts/no-verify-test.md');
            mkdirSync(dirname(verdictPath), { recursive: true });
            writeFileSync(verdictPath, '# verdict\n');
            return {
              paths: [verdictPath],
              commitMessage: 'verdict(test): no-verify hook bypass',
              prTitle: 'verdict(test): no-verify hook bypass',
              prBody: 'regression test for 砚砚 [爪感差] hook leak',
            };
          },
        });
      } catch (_gh_pr_failure_expected) {
        void _gh_pr_failure_expected;
      }

      // Assert: the commit IS on origin. Without --no-verify the hook would have blocked
      // it and nothing would have been pushed.
      const remoteBranchSha = execFileSync('git', ['rev-parse', `refs/heads/${branchName}`], {
        cwd: remoteRoot,
        encoding: 'utf-8',
      }).trim();
      assert.match(
        remoteBranchSha,
        /^[0-9a-f]{40}$/,
        'verdict commit must have been pushed to origin despite the failing pre-commit hook',
      );
      const commitMsg = execFileSync('git', ['log', '-1', '--format=%s', remoteBranchSha], {
        cwd: remoteRoot,
        encoding: 'utf-8',
      }).trim();
      assert.equal(commitMsg, 'verdict(test): no-verify hook bypass', 'pushed commit must be the verdict commit');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(remoteRoot, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(hooksDir, { recursive: true, force: true });
    }
  });

  it('does not delete a branch that already existed before the publish attempt', async (t) => {
    const { repoRoot, remoteRoot } = createRepoWithOrigin();
    const branchName = 'verdict/auto/eval-task-outcome/pre-existing-branch';
    execFileSync('git', ['branch', branchName, 'HEAD'], { cwd: repoRoot, stdio: 'ignore' });

    const worktreePath = fs.mkdtempSync(join(tmpdir(), 'publish-wt-target-'));
    writeFileSync(join(worktreePath, 'non-empty.txt'), 'trigger failure without ownership\n');

    t.mock.method(fs, 'mkdtempSync', () => worktreePath);
    syncBuiltinESMExports();

    try {
      const { createGitWorktreePublisher } = await import(
        `../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js?t=${Date.now()}-keep`
      );
      const publisher = createTestPublisher(createGitWorktreePublisher, repoRoot);

      await assert.rejects(
        publisher.publishOnIsolatedWorktree({
          branchName,
          sourceBase: 'origin/main',
          stage: async () => {
            throw new Error('stage should not run when worktree add fails');
          },
        }),
      );

      assert.equal(
        branchExists(repoRoot, branchName),
        true,
        'cleanup must not delete a branch that predates this publish attempt',
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(remoteRoot, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  // 砚砚 PR #2682 R1: with `--no-verify` bypassing the pre-commit guards (biome /
  // Brand / Shared-State / Root hygiene), the publisher itself MUST hard-reject any
  // stage path outside the 5 legitimate verdict prefixes. Otherwise a future generator
  // adapter bug could stage `packages/web/...`, `docs/ROADMAP.md`, `cat-config.json`,
  // or root debris and bypass every guard wholesale.
  // Four it() blocks (one per sensitive category) instead of one it() with a for-loop
  // so each gets its own t.mock scope — t.mock.method on fs.mkdtempSync lives until
  // end-of-it and would leak into the next iteration's createRepoWithOrigin call.
  async function assertAllowlistRejects(t, label, relPath, content) {
    const { repoRoot, remoteRoot } = createRepoWithOrigin();
    const remoteInitialSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: remoteRoot,
      encoding: 'utf-8',
    }).trim();
    const branchName = `verdict/auto/eval-a2a/allowlist-reject-${label}`;
    const worktreePath = fs.mkdtempSync(join(tmpdir(), 'publish-wt-target-'));
    rmSync(worktreePath, { recursive: true, force: true });
    t.mock.method(fs, 'mkdtempSync', () => worktreePath);
    syncBuiltinESMExports();

    try {
      const { createGitWorktreePublisher } = await import(
        `../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js?t=${Date.now()}-allow-${label}`
      );
      const publisher = createTestPublisher(createGitWorktreePublisher, repoRoot);

      await assert.rejects(
        publisher.publishOnIsolatedWorktree({
          branchName,
          sourceBase: 'origin/main',
          stage: async (wt) => {
            const p = join(wt, relPath);
            mkdirSync(dirname(p), { recursive: true });
            writeFileSync(p, content);
            return {
              paths: [p],
              commitMessage: `should-not-commit (${label})`,
              prTitle: 'should not reach PR',
              prBody: 'should not reach PR',
            };
          },
        }),
        (err) => /staged_path_outside_allowlist/.test(err.message),
        `publisher must reject ${label} path before commit`,
      );

      // Branch must NOT exist on the remote (allowlist rejected before push).
      let branchOnRemote = false;
      try {
        execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branchName}`], {
          cwd: remoteRoot,
          stdio: 'ignore',
        });
        branchOnRemote = true;
      } catch {
        branchOnRemote = false;
      }
      assert.equal(branchOnRemote, false, `${label}: branch must NOT be pushed when allowlist rejects`);

      // Remote HEAD must be unchanged — no foreign data leaked through.
      const remoteHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: remoteRoot,
        encoding: 'utf-8',
      }).trim();
      assert.equal(remoteHeadSha, remoteInitialSha, `${label}: remote HEAD must be unchanged`);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(remoteRoot, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  it('allowlist rejects brand-protected packages/web path before commit (砚砚 PR #2682 R1)', async (t) => {
    await assertAllowlistRejects(t, 'brand-web-layout', 'packages/web/src/app/layout.tsx', '// brand\n');
  });

  it('allowlist rejects shared-state docs/ROADMAP.md before commit (砚砚 PR #2682 R1)', async (t) => {
    await assertAllowlistRejects(t, 'shared-state-backlog', 'docs/ROADMAP.md', '# backlog\n');
  });

  it('allowlist rejects shared-state cat-config.json before commit (砚砚 PR #2682 R1)', async (t) => {
    await assertAllowlistRejects(t, 'shared-state-catconfig', 'cat-config.json', '{}\n');
  });

  it('allowlist rejects root debris before commit (砚砚 PR #2682 R1)', async (t) => {
    await assertAllowlistRejects(t, 'root-debris-log', 'rogue.log', 'leak\n');
  });

  // 砚砚 PR #2682 R2: R1's string-startsWith allowlist is bypassable via path
  // traversal — a stage callback returning the RAW string
  // `docs/harness-feedback/verdicts/../../../cat-config.json` (not join(wt, ...))
  // (a) passes startsWith('docs/harness-feedback/verdicts/'), (b) is interpreted
  // by `git -C <worktree> add` as worktree-relative → writes to cat-config.json
  // at the worktree root → bypasses the allowlist entirely.
  // R2 fix normalizes against worktreePath before allowlist comparison, so the
  // collapsed relative path is the real target (`cat-config.json`), which the
  // allowlist correctly rejects. Also throws `staged_path_outside_worktree` when
  // the resolved path escapes the worktree (e.g. `/etc/passwd`, `../../../etc/foo`).
  async function assertRawPathRejects(t, label, rawPath, expectedErrorPattern) {
    const { repoRoot, remoteRoot } = createRepoWithOrigin();
    const remoteInitialSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: remoteRoot,
      encoding: 'utf-8',
    }).trim();
    const branchName = `verdict/auto/eval-a2a/raw-path-${label}`;
    const worktreePath = fs.mkdtempSync(join(tmpdir(), 'publish-wt-target-'));
    rmSync(worktreePath, { recursive: true, force: true });
    t.mock.method(fs, 'mkdtempSync', () => worktreePath);
    syncBuiltinESMExports();

    try {
      const { createGitWorktreePublisher } = await import(
        `../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js?t=${Date.now()}-raw-${label}`
      );
      const publisher = createTestPublisher(createGitWorktreePublisher, repoRoot);

      await assert.rejects(
        publisher.publishOnIsolatedWorktree({
          branchName,
          sourceBase: 'origin/main',
          // Note: stage callback DOES NOT actually write the file. The publisher's
          // path normalization must reject BEFORE any I/O. If the test was passing
          // by file-not-found rather than allowlist/escape detection, that would be
          // a different (still bug-ish) outcome — but we assert the specific error.
          stage: async () => ({
            paths: [rawPath], // RAW string, NOT join(wt, ...) — this is the attack vector
            commitMessage: `should-not-commit (${label})`,
            prTitle: 'should not reach PR',
            prBody: 'should not reach PR',
          }),
        }),
        (err) => expectedErrorPattern.test(err.message),
        `publisher must reject ${label} with ${expectedErrorPattern}; got: ${''}`,
      );

      let branchOnRemote = false;
      try {
        execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branchName}`], {
          cwd: remoteRoot,
          stdio: 'ignore',
        });
        branchOnRemote = true;
      } catch {
        branchOnRemote = false;
      }
      assert.equal(branchOnRemote, false, `${label}: branch must NOT be pushed`);

      const remoteHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: remoteRoot,
        encoding: 'utf-8',
      }).trim();
      assert.equal(remoteHeadSha, remoteInitialSha, `${label}: remote HEAD must be unchanged`);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(remoteRoot, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  it('rejects relative path traversal that字面 matches an allowed prefix (砚砚 PR #2682 R2)', async (t) => {
    // The attack: `docs/harness-feedback/verdicts/<allowed-by-prefix>` followed by
    // `../../../` to escape the verdicts/ subtree and land on cat-config.json at the
    // worktree root. R1 string-startsWith would accept this; R2 path normalization
    // collapses it to `cat-config.json` which the allowlist correctly rejects.
    await assertRawPathRejects(
      t,
      'verdict-prefix-traversal-to-catconfig',
      'docs/harness-feedback/verdicts/../../../cat-config.json',
      /staged_path_outside_allowlist/,
    );
  });

  it('rejects absolute path outside the worktree (砚砚 PR #2682 R2)', async (t) => {
    // Stage callback returns an absolute path NOT under the worktree. The R2 fix
    // detects this via `!absolute.startsWith(worktreePath + sep)` and throws the
    // distinct `staged_path_outside_worktree` error.
    await assertRawPathRejects(t, 'absolute-etc-passwd', '/etc/passwd', /staged_path_outside_worktree/);
  });

  it('rejects deep ../ traversal that escapes the worktree root (砚砚 PR #2682 R2)', async (t) => {
    // Many leading `../` segments resolve to an absolute path above the worktree.
    // Caught by the same outside-worktree throw (not the allowlist, because we
    // never even get to compute a worktree-relative slice).
    await assertRawPathRejects(
      t,
      'deep-dotdot-escape',
      '../../../../../../../../etc/passwd',
      /staged_path_outside_worktree/,
    );
  });

  it('rejects same-prefix masquerade outside the worktree (砚砚 PR #2682 R2)', async (t) => {
    // If worktreePath is `/tmp/abc`, then `/tmp/abc-evil/sneak.txt` startsWith
    // `worktreePath` (no separator). The R2 fix uses `worktreePath + sep` to
    // require a path separator, preventing this masquerade.
    // Build the masquerade path against the predictable worktreePath created above.
    // We use a separate helper that constructs the path explicitly so the assertion
    // exercises the sep-guard, not a generic outside-worktree case.
    const { repoRoot, remoteRoot } = createRepoWithOrigin();
    const remoteInitialSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: remoteRoot,
      encoding: 'utf-8',
    }).trim();
    const branchName = 'verdict/auto/eval-a2a/raw-path-same-prefix-masquerade';
    const worktreePath = fs.mkdtempSync(join(tmpdir(), 'publish-wt-target-'));
    rmSync(worktreePath, { recursive: true, force: true });
    const masqueradePath = `${worktreePath}-evil-sneak.txt`;
    // Create the masquerade file so any non-rejecting code path would actually find it.
    writeFileSync(masqueradePath, 'sneak\n');
    t.mock.method(fs, 'mkdtempSync', () => worktreePath);
    syncBuiltinESMExports();

    try {
      const { createGitWorktreePublisher } = await import(
        `../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js?t=${Date.now()}-masquerade`
      );
      const publisher = createTestPublisher(createGitWorktreePublisher, repoRoot);

      await assert.rejects(
        publisher.publishOnIsolatedWorktree({
          branchName,
          sourceBase: 'origin/main',
          stage: async () => ({
            paths: [masqueradePath],
            commitMessage: 'should-not-commit (same-prefix masquerade)',
            prTitle: 'should not reach PR',
            prBody: 'should not reach PR',
          }),
        }),
        (err) => /staged_path_outside_worktree/.test(err.message),
        'same-prefix masquerade must be rejected by the sep-guard',
      );

      const remoteHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: remoteRoot,
        encoding: 'utf-8',
      }).trim();
      assert.equal(remoteHeadSha, remoteInitialSha, 'masquerade: remote HEAD must be unchanged');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(remoteRoot, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(masqueradePath, { force: true });
    }
  });
});
