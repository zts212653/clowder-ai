import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { GitPublisher, PublishOnIsolatedWorktreeOpts } from './publish-verdict.js';

const exec = promisify(execFile);

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
}

export function createGitWorktreePublisher(deps: GitWorktreePublisherDeps): GitPublisher {
  return {
    async publishOnIsolatedWorktree(opts: PublishOnIsolatedWorktreeOpts) {
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
        // 1. Fetch latest origin/main to ensure isolated worktree is current
        await exec('git', ['-C', deps.repoRoot, 'fetch', 'origin', 'main'], { timeout: 60_000 });

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
        // Convert absolute paths to repo-relative so `git add` works inside worktree
        const relativePaths = paths.map((p) => {
          const rel = resolve(p).startsWith(worktreePath) ? resolve(p).slice(worktreePath.length + 1) : p;
          return rel;
        });
        // cloud R4 P1 (PR-2): some generators write evidence that lives at paths covered by
        // .gitignore (cw raw inputs at `generated/capability-wakeup/<verdictId>/` — see
        // `.gitignore:209`). Stage callback's path list is explicit contract for "must be in
        // commit"; `-f` forces inclusion (no-op for non-ignored paths). Without -f, `git add`
        // exits non-zero with "paths are ignored" and the whole publish fails.
        await exec('git', ['-C', worktreePath, 'add', '-f', '--', ...relativePaths], { timeout: 30_000 });
        await exec('git', ['-C', worktreePath, 'commit', '-m', commitMessage], { timeout: 30_000 });

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
            await exec('gh', args, { cwd: worktreePath, timeout: 15_000 });
          } catch (err) {
            // Best-effort: surface error on gh pr create below if it actually breaks PR.
            // (Swallowing here = avoid double-fail on label step; PR create will retry.)
            void err;
          }
        }
        const labelFlags = (labels ?? []).flatMap((label) => ['--label', label]);
        const prResult = await exec(
          'gh',
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
          { cwd: worktreePath, timeout: 60_000 },
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
              [
                'pr',
                'close',
                prUrl,
                '--delete-branch',
                '--comment',
                'Closing stale auto-verdict PR because post-publish writeback failed.',
              ],
              { cwd: worktreePath, timeout: 60_000 },
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
                ['pr', 'list', '--head', opts.branchName, '--state', 'open', '--json', 'state', '--limit', '1'],
                { cwd: deps.repoRoot, timeout: 30_000 },
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
  };
}
