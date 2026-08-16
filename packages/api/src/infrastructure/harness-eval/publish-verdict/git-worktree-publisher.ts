import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { withHiddenGhCliWindow } from '../../github/gh-cli-env.js';
import { createGitVerdictPrRefresher } from './git-verdict-pr-refresher.js';
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
}

export interface VerdictPublishContractInput {
  repoRoot: string;
  expectedRepoFullName: string;
  remoteName: string;
  baseRef: string;
  sourceRef: string;
  identityOnly?: boolean;
}

export type VerdictPublishContractRunner = (input: VerdictPublishContractInput) => Promise<void>;

export function withGitHubRepoScope(args: string[], expectedRepoFullName: string): string[] {
  return [...args, '--repo', expectedRepoFullName];
}

async function runVerdictPublishContract(input: VerdictPublishContractInput): Promise<void> {
  const scriptPath = resolve(input.repoRoot, 'scripts/check-verdict-publish-contract.mjs');
  await exec(
    process.execPath,
    [
      scriptPath,
      '--repo-root',
      input.repoRoot,
      '--expected-repo',
      input.expectedRepoFullName,
      '--remote',
      input.remoteName,
      '--base-ref',
      input.baseRef,
      '--source-ref',
      input.sourceRef,
      ...(input.identityOnly ? ['--identity-only', 'true'] : []),
    ],
    { timeout: 60_000 },
  );
}

export function createGitWorktreePublisher(deps: GitWorktreePublisherDeps): GitPublisher {
  const contractRunner = deps.contractRunner ?? runVerdictPublishContract;
  return {
    async publishOnIsolatedWorktree(opts: PublishOnIsolatedWorktreeOpts) {
      const sourceContract = {
        repoRoot: deps.repoRoot,
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
        const { paths, commitMessage, prTitle, prBody, labels, afterPublish } = await opts.stage(worktreePath);

        if (paths.length === 0) {
          throw new Error('stage produced no paths to commit');
        }

        // 4. Add + commit artifacts inside isolated worktree
        // 砚砚 PR #2682 R2: normalize stage paths against the WORKTREE root (not
        // process.cwd()) before any allowlist check, so traversal segments are
        // collapsed BEFORE prefix comparison.
        // R1 bug 砚砚 caught: `resolve(p)` resolves relative paths against process.cwd
        // (likely the API server's cwd, not the worktree), and if the result didn't
        // start with worktreePath, the old code fell through to the raw string `p`.
        // A stage callback returning the literal string
        //   `docs/harness-feedback/verdicts/../../../cat-config.json`
        // would (a) fail the resolve(p).startsWith(worktreePath) check, (b) fall
        // through to the raw string, (c) pass `startsWith('docs/harness-feedback/verdicts/')`
        // by字面 match, and (d) be interpreted by `git -C <worktreePath> add` as a
        // worktree-relative path → after collapsing `..`, write to `cat-config.json`
        // at the worktree root. Trivial bypass of the allowlist.
        // Fix: `resolve(worktreePath, p)` so relative paths normalize relative to the
        // worktree, then explicitly reject anything that escapes the worktree root
        // (e.g. p = `/etc/passwd` or `../../../../../../etc/passwd`).
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

        // 7. Open auto-PR via gh.
        // 砚砚 R4 P1 cloud: `--repo .` is NOT valid gh syntax (fails with
        // 'expected the "[HOST/]OWNER/REPO" format'). Rely on cwd inside the
        // worktree — gh auto-detects owner/repo from the git remote.
        //
        // PR-3 (砚砚 R2): pass each label via separate `--label` flag (gh CLI accepts
        // repeated --label X; not comma-separated). `computePublishPolicy` decides
        // labels per packet/attribution.
        //
        // PR-3 R1 (砚砚 cloud): `gh pr create --label X` fails if label doesn't exist
        // in repo. Ensure labels exist via `gh label create --force` (idempotent —
        // creates if missing, updates if exists; either way safe). Errors swallowed:
        // if label creation fails (network / permissions), we still try `gh pr create`
        // — better to surface label error there than to block the publish entirely.
        const standardLabelMeta: Record<string, { color: string; description: string }> = {
          'evidence-only': {
            color: '0E8A16',
            description: 'F192 auto-verdict artifact PR — cat-owned merge per SOP, not operator',
          },
          'no-action-needed': {
            color: 'C5DEF5',
            description: 'F192 keep_observe + no actionable findings — interim per-run PR (rollup deferred)',
          },
        };
        for (const label of labels ?? []) {
          const meta = standardLabelMeta[label];
          const args = ['label', 'create', label, '--force'];
          if (meta) {
            args.push('--color', meta.color, '--description', meta.description);
          }
          try {
            await exec(
              'gh',
              withGitHubRepoScope(args, deps.expectedRepoFullName),
              withHiddenGhCliWindow({ cwd: worktreePath, timeout: 15_000 }),
            );
          } catch (err) {
            // Best-effort: surface error on gh pr create below if it actually breaks PR.
            // (Swallowing here = avoid double-fail on label step; PR create will retry.)
            void err;
          }
        }
        const labelFlags = (labels ?? []).flatMap((label) => ['--label', label]);
        const prResult = await exec(
          'gh',
          withGitHubRepoScope(
            [
              'pr',
              'create',
              '--base',
              'main',
              '--head',
              opts.branchName,
              '--title',
              prTitle,
              '--body',
              prBody,
              ...labelFlags,
            ],
            deps.expectedRepoFullName,
          ),
          withHiddenGhCliWindow({ cwd: worktreePath, timeout: 60_000 }),
        );
        prUrl =
          prResult.stdout
            .trim()
            .split('\n')
            .find((line) => line.startsWith('https://')) ?? prResult.stdout.trim();
        prOpened = true;
        await afterPublish?.();

        return { commitSha, prUrl };
      } catch (err) {
        if (prOpened && prUrl) {
          try {
            await exec(
              'gh',
              withGitHubRepoScope(
                [
                  'pr',
                  'close',
                  prUrl,
                  '--delete-branch',
                  '--comment',
                  'Closing stale auto-verdict PR because post-publish writeback failed.',
                ],
                deps.expectedRepoFullName,
              ),
              withHiddenGhCliWindow({ cwd: worktreePath, timeout: 60_000 }),
            );
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
    }),
  };
}
