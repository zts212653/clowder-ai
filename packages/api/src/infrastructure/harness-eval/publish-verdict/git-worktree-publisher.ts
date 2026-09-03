import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { withHiddenGhCliWindow } from '../../github/gh-cli-env.js';
import { createGitVerdictPrRefresher } from './git-verdict-pr-refresher.js';
import { closeAutoVerdictPr, openAutoVerdictPr, withGitHubRepoScope } from './publication/git-verdict-pr.js';
import {
  type PublishVerdictCommitStatusesInput,
  publishVerdictCommitStatuses,
} from './publication/verdict-commit-status-publisher.js';
import {
  runVerdictPublishContract,
  type VerdictPublishContractInput,
  type VerdictPublishContractRunner,
} from './publication/verdict-publish-contract-runner.js';
import type { GitPublisher, PublishOnIsolatedWorktreeOpts } from './publish-verdict.js';

const exec = promisify(execFile);

const ALLOWED_PATH_PREFIXES = [
  'docs/harness-feedback/verdicts/',
  'docs/harness-feedback/bundles/',
  'generated/capability-wakeup/',
  'generated/memory/',
  'generated/sop/',
];
const ALLOWED_EXACT_PATHS = new Set(['docs/harness-feedback/registry/measurement-bundles.yaml']);

export function isAllowedVerdictStagePath(relativePath: string): boolean {
  return (
    ALLOWED_EXACT_PATHS.has(relativePath) || ALLOWED_PATH_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
  );
}

/**
 * F192 Phase H — Real GitPublisher impl using `git worktree add` + `gh pr create`.
 *
 * Creates an isolated worktree from `origin/main`, runs the caller's `stage`
 * callback inside it (which calls the verdict generator), commits the
 * generated artifacts to a NEW branch, pushes it to `origin`, and opens an
 * auto-PR via `gh`. The isolated worktree is removed in a `finally` block so
 * neither success nor failure pollutes the live worktree.
 *
 * 砚砚 R1 P1 #1: handler's live `harnessFeedbackRoot` is never mutated by this
 * impl — all writes go through the isolated worktree.
 *
 * 砚砚 R1 P2 #2 (race protection): `git worktree add -b <branch>` fails
 * atomically if the branch already exists, surfacing as
 * `git_or_gh_failed: fatal: A branch named ... already exists`.
 */
export interface GitWorktreePublisherDeps {
  /** Repo root the API server is running in (must be a git checkout with `origin`). */
  repoRoot: string;
  /** Canonical GitHub owner/repo; publishing fails closed if origin differs. */
  expectedRepoFullName: string;
  /** Test seam for the shared executable publication contract. */
  contractRunner?: VerdictPublishContractRunner;
  /** Test seam for the local-guard → exact-commit GitHub status projection. */
  commitStatusPublisher?: (input: PublishVerdictCommitStatusesInput) => Promise<void>;
}

export { withGitHubRepoScope } from './publication/git-verdict-pr.js';
export type {
  VerdictPublishContractInput,
  VerdictPublishContractRunner,
} from './publication/verdict-publish-contract-runner.js';

export function createGitWorktreePublisher(deps: GitWorktreePublisherDeps): GitPublisher {
  const contractRunner = deps.contractRunner ?? runVerdictPublishContract;
  const commitStatusPublisher = deps.commitStatusPublisher ?? publishVerdictCommitStatuses;
  return {
    async publishOnIsolatedWorktree(opts: PublishOnIsolatedWorktreeOpts) {
      const sourceContract = {
        repoRoot: deps.repoRoot,
        implementationRoot: deps.repoRoot,
        expectedRepoFullName: deps.expectedRepoFullName,
        remoteName: 'origin',
        baseRef: opts.sourceBase,
        sourceRef: opts.sourceBase,
      } satisfies VerdictPublishContractInput;

      // Verify repository identity before contacting the remote, then validate
      // corpus completeness against the freshly fetched source ref. A stale
      // local origin/main must not recreate the missing-census failure mode.
      await contractRunner({ ...sourceContract, identityOnly: true });
      await exec('git', ['-C', deps.repoRoot, 'fetch', 'origin', 'main'], { timeout: 60_000 });
      // Re-check the freshly fetched source so an incomplete origin/main cannot
      // produce a generator_failed result that invites a manual escape hatch.
      await contractRunner(sourceContract);

      // Use mkdtemp to get a guaranteed-unique path; suffix with PID for debuggability
      const worktreePath = mkdtempSync(`${tmpdir()}/cat-cafe-publish-verdict-${process.pid}-`);

      // 砚砚 R4 P2 cloud: track whether PR was opened so failure cleanup can
      // delete the local branch (worktree add -b creates branch + worktree;
      // worktree remove only removes worktree, leaving branch behind for
      // retries to hit "branch already exists" race).
      let prOpened = false;
      let pushSucceeded = false;
      let prUrl: string | null = null;
      let branchExistedBefore = false;

      try {
        // Probe upfront so partial-failure cleanup never deletes a pre-existing branch.
        try {
          await exec('git', ['-C', deps.repoRoot, 'rev-parse', '--verify', `refs/heads/${opts.branchName}`], {
            timeout: 10_000,
          });
          branchExistedBefore = true;
        } catch {
          branchExistedBefore = false;
        }

        // 2. Create isolated worktree on a new branch from origin/main
        //    Atomic: fails if branch already exists (race protection)
        await exec(
          'git',
          ['-C', deps.repoRoot, 'worktree', 'add', '-b', opts.branchName, worktreePath, opts.sourceBase],
          { timeout: 60_000 },
        );

        // 3. Run caller's stage callback (generator writes verdict artifacts)
        const { paths, commitMessage, prTitle, prBody, labels, statusChecks, afterPublish } =
          await opts.stage(worktreePath);

        if (paths.length === 0) {
          throw new Error('stage produced no paths to commit');
        }

        // Normalize against the worktree before the allowlist. Resolving raw
        // paths against process.cwd() once allowed traversal-shaped strings to
        // masquerade under an approved prefix (PR #2682); escape fails closed.
        const relativePaths = paths.map((p) => {
          const absolute = resolve(worktreePath, p);
          // Escape detection: absolute must equal worktreePath (= the root itself, an
          // edge case we still reject because committing the root is meaningless) or
          // start with `worktreePath + sep`. The sep guard prevents the same-prefix
          // masquerade case (e.g. `/tmp/worktreePath-evil/...` vs `/tmp/worktreePath`).
          if (absolute !== worktreePath && !absolute.startsWith(worktreePath + sep)) {
            throw new Error(
              `staged_path_outside_worktree: stage callback returned path '${p}' which resolved to '${absolute}', outside the isolated worktree root '${worktreePath}'. Stage callbacks must only write inside the worktree.`,
            );
          }
          // Slice off worktreePath + sep to get the repo-relative path. Equality case
          // (absolute === worktreePath) returns empty string, which the allowlist
          // below rejects (no prefix matches empty).
          return absolute === worktreePath ? '' : absolute.slice(worktreePath.length + 1);
        });

        // 砚砚 PR #2682 R1: publisher-level hard allowlist (replaces R0's comment-only
        // scope claim). The commit below uses `--no-verify` to bypass `.githooks/pre-commit`
        // (necessary because the isolated worktree has no node_modules, so the hook's
        // `pnpm run check:biome-version` deterministically fails). With hooks bypassed, the
        // ONLY backstop preventing a buggy/compromised generator adapter from staging
        // `packages/web/...` (brand-protected), `docs/ROADMAP.md` / `cat-config.json`
        // (shared-state), or root debris (`*.log` / `*.rdb`) IS this allowlist.
        // The 5 prefixes plus one exact F267 census file mirror the artifact contract:
        //   - `docs/harness-feedback/verdicts/<id>.md`   ← verdict markdown
        //   - `docs/harness-feedback/bundles/<id>/`      ← bundle dir
        //   - `generated/{capability-wakeup,memory,sop}/<verdictId>/`
        //                                                ← extraStagedPaths (cw/memory/sop
        //                                                  raw inputs referenced by
        //                                                  provenance.json sha256)
        //   - `docs/harness-feedback/registry/measurement-bundles.yaml`
        //                                                ← refreshed derived verdict counts
        // Any new generator adding a new path MUST extend this allowlist explicitly +
        // add a regression test below — defaulting to deny.
        const outsideAllowlist = relativePaths.filter((rel) => !isAllowedVerdictStagePath(rel));
        if (outsideAllowlist.length > 0) {
          throw new Error(
            `staged_path_outside_allowlist: stage callback returned ${outsideAllowlist.length} path(s) outside the verdict allowlist: ${JSON.stringify(outsideAllowlist)}. Allowed prefixes: ${ALLOWED_PATH_PREFIXES.join(', ')}. Allowed exact paths: ${[...ALLOWED_EXACT_PATHS].join(', ')}. Verdict commits use --no-verify so the pre-commit guards (biome/brand/shared-state) cannot catch foreign paths; this allowlist is the only backstop.`,
          );
        }

        // cloud R4 P1 (PR-2): some generators write evidence that lives at paths covered by
        // .gitignore (cw raw inputs at `generated/capability-wakeup/<verdictId>/` — see
        // `.gitignore:209`). Stage callback's path list is explicit contract for "must be in
        // commit"; `-f` forces inclusion (no-op for non-ignored paths). Without -f, `git add`
        // exits non-zero with "paths are ignored" and the whole publish fails.
        await exec('git', ['-C', worktreePath, 'add', '-f', '--', ...relativePaths], { timeout: 30_000 });
        // `--no-verify`: skip `.githooks/pre-commit` for machine-generated verdict commits.
        // The hook runs `pnpm run check:biome-version` + `pnpm exec biome check .`, both
        // requiring `node_modules` in the working tree. Isolated worktrees created by
        // `git worktree add` (line ~64) have NO `node_modules` (we never `pnpm install`
        // inside them — they are throwaway), so the hook deterministically fails with
        // truncated 500 `git_or_gh_failed` from the publish_verdict MCP tool.
        // The path allowlist above is the backstop that replaces the bypassed guards.
        // Friction provenance: 砚砚 2026-06-29 [爪感差] (transient) → 2026-06-30 [爪感差]
        // (deterministic root cause pinned to this line) on thread_eval_a2a;
        // 砚砚 PR #2682 R1: scope论证 was only in comment → promoted to hard guard above.
        await exec('git', ['-C', worktreePath, 'commit', '--no-verify', '-m', commitMessage], { timeout: 30_000 });

        // The shared guard is the final transport boundary for owner identity,
        // census continuity, and same-domain/same-window collision checks.
        await contractRunner({
          repoRoot: worktreePath,
          implementationRoot: deps.repoRoot,
          expectedRepoFullName: deps.expectedRepoFullName,
          remoteName: 'origin',
          baseRef: opts.sourceBase,
          sourceRef: 'HEAD',
        });

        // 5. Push branch to origin
        await exec('git', ['-C', worktreePath, 'push', '-u', 'origin', opts.branchName], { timeout: 120_000 });
        pushSucceeded = true;

        // 6. Get commit SHA (after commit, before PR)
        const shaResult = await exec('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { timeout: 10_000 });
        const commitSha = shaResult.stdout.trim();
        await commitStatusPublisher({
          repoFullName: deps.expectedRepoFullName,
          headSha: commitSha,
          statuses: statusChecks ?? [],
        });

        // The status is written before the PR exists. If status publication
        // fails, the finally path removes the pushed branch and no PR escapes.
        prUrl = await openAutoVerdictPr({
          expectedRepoFullName: deps.expectedRepoFullName,
          worktreePath,
          branchName: opts.branchName,
          title: prTitle,
          body: prBody,
          labels,
        });
        prOpened = true;
        await afterPublish?.();

        return { commitSha, prUrl };
      } catch (err) {
        if (prOpened && prUrl) {
          try {
            await closeAutoVerdictPr({ expectedRepoFullName: deps.expectedRepoFullName, worktreePath, prUrl });
            prOpened = false;
          } catch (cleanupErr) {
            const originalMessage = err instanceof Error ? err.message : String(err);
            const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
            throw new Error(
              `post_publish_cleanup_failed: exposed PR ${prUrl} could not be closed after publish hook failed. original=${originalMessage}; cleanup=${cleanupMessage}`,
            );
          }
        }
        throw err;
      } finally {
        // Cleanup: always attempt worktree removal. `git worktree add -b` can
        // create the branch before failing the worktree setup; best-effort
        // removal here keeps admin metadata from lingering across retries.
        try {
          await exec('git', ['-C', deps.repoRoot, 'worktree', 'remove', '--force', worktreePath], {
            timeout: 30_000,
          });
        } catch {
          // Worktree may never have registered or may already be gone.
        }

        // 砚砚 R4 P2 + Day-6 cron bug: cleanup on failure so retries don't collide.
        // If PR was opened, leave both branches (PR is the source).
        // If push succeeded but gh failed → remote branch leaks → next retry's
        // worktree-add succeeds locally but push -u rejects (non-fast-forward).
        //
        // Important: `git worktree add -b` can partially create the local branch
        // even when the command throws. Delete only if the branch did NOT exist
        // before this publish attempt, otherwise we might destroy a live branch.
        if (!prOpened) {
          if (!branchExistedBefore) {
            try {
              await exec('git', ['-C', deps.repoRoot, 'branch', '-D', opts.branchName], { timeout: 10_000 });
            } catch {
              // Branch may not exist (or partial create never happened) — best-effort cleanup
            }
          }
          // 砚砚 R13/R14/R15 P2: probe with `gh pr list` (not `pr view`) — view
          // exits 1 on "no PR" (the COMMON case after gh pr create transient fail),
          // which would conflate "confirmed no PR" with "auth/network inconclusive".
          // `gh pr list --head <branch> --state open --json state --limit 1` returns:
          //   probe SUCCESS + empty array → confirmed no open PR, safe to delete
          //   probe SUCCESS + non-empty array → PR is live, KEEP branch
          //   probe FAILED (network/auth/etc.) → inconclusive, KEEP branch
          //     (R14 P2: orphan branch noise < orphaning a live PR's source)
          if (pushSucceeded) {
            let safeToDelete = false;
            try {
              const probe = await exec(
                'gh',
                withGitHubRepoScope(
                  ['pr', 'list', '--head', opts.branchName, '--state', 'open', '--json', 'state', '--limit', '1'],
                  deps.expectedRepoFullName,
                ),
                withHiddenGhCliWindow({ cwd: deps.repoRoot, timeout: 30_000 }),
              );
              const parsed = JSON.parse(probe.stdout) as Array<{ state?: string }>;
              if (Array.isArray(parsed) && parsed.length === 0) safeToDelete = true;
            } catch {
              // probe inconclusive → keep branch (conservative; orphan branch < deleted live PR source)
            }
            if (safeToDelete) {
              try {
                await exec('git', ['-C', deps.repoRoot, 'push', '--delete', 'origin', opts.branchName], {
                  timeout: 30_000,
                });
              } catch {
                // Remote branch may not exist or network failed — best effort
              }
            }
          }
        }
        // Belt-and-suspenders: rmSync in case `git worktree remove` failed
        try {
          rmSync(worktreePath, { recursive: true, force: true });
        } catch {
          // Already gone or never created
        }
      }
    },
    refreshPublishedVerdictPr: createGitVerdictPrRefresher({
      repoRoot: deps.repoRoot,
      expectedRepoFullName: deps.expectedRepoFullName,
      contractRunner,
      commitStatusPublisher,
    }),
  };
}
