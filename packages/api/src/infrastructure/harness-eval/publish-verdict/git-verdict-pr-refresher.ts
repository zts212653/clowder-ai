import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { withHiddenGhCliWindow } from '../../github/gh-cli-env.js';
import { MEASUREMENT_BUNDLE_CENSUS_REF } from '../measurement/measurement-bundle-census-file.js';
import {
  type PublishVerdictCommitStatusesInput,
  publishVerdictCommitStatuses,
} from './publication/verdict-commit-status-publisher.js';
import {
  runVerdictPublishContract,
  type VerdictPublishContractRunner,
} from './publication/verdict-publish-contract-runner.js';
import {
  acquireLocalBranchForRefresh,
  deleteOwnedLocalBranch,
  type OpenVerdictPr,
  resolveLocalBranchOwnership,
} from './refresh/verdict-refresh-branch-state.js';
import { publishRefreshedVerdictCommit } from './refresh/verdict-refresh-publication.js';
import type { RefreshPublishedVerdictPrOpts, RefreshPublishedVerdictPrResult } from './types.js';

const exec = promisify(execFile);
const PUBLISH_MARKER = 'Verdict published via cat_cafe_publish_verdict MCP tool.';

export interface GitVerdictPrRefresherDeps {
  repoRoot: string;
  expectedRepoFullName: string;
  identityRunner?: (repoRoot: string, expectedRepoFullName: string) => Promise<void>;
  contractRunner?: VerdictPublishContractRunner;
  commitStatusPublisher?: (input: PublishVerdictCommitStatusesInput) => Promise<void>;
  resolveOpenPr?: (branchName: string) => Promise<OpenVerdictPr[]>;
  beforeAcquireLocalBranch?: (args: { repoRoot: string; branchName: string; branchHead: string }) => Promise<void>;
  beforeAttachLocalBranch?: (args: { repoRoot: string; branchName: string; branchHead: string }) => Promise<void>;
  beforePreparePinnedPush?: (args: {
    repoRoot: string;
    worktreePath: string;
    branchName: string;
    branchHead: string;
    commitSha: string;
  }) => Promise<void>;
}

async function defaultIdentityRunner(repoRoot: string, expectedRepoFullName: string): Promise<void> {
  await exec(
    process.execPath,
    [
      resolve(repoRoot, 'scripts/check-verdict-publish-contract.mjs'),
      '--repo-root',
      repoRoot,
      '--expected-repo',
      expectedRepoFullName,
      '--remote',
      'origin',
      '--identity-only',
      'true',
    ],
    { cwd: repoRoot, timeout: 30_000 },
  );
}

async function verifyPublisherIdentity(deps: GitVerdictPrRefresherDeps): Promise<void> {
  const identityRunner = deps.identityRunner ?? defaultIdentityRunner;
  await identityRunner(deps.repoRoot, deps.expectedRepoFullName);
}

function resolveConfiguredOpenPr(deps: GitVerdictPrRefresherDeps): (branchName: string) => Promise<OpenVerdictPr[]> {
  if (deps.resolveOpenPr) return deps.resolveOpenPr;
  return (branchName) => defaultResolveOpenPr(deps.repoRoot, deps.expectedRepoFullName, branchName);
}

async function defaultResolveOpenPr(
  repoRoot: string,
  expectedRepoFullName: string,
  branchName: string,
): Promise<OpenVerdictPr[]> {
  const result = await exec(
    'gh',
    [
      'pr',
      'list',
      '--head',
      branchName,
      '--base',
      'main',
      '--state',
      'open',
      '--limit',
      '2',
      '--json',
      'url,headRefOid,headRefName,baseRefName,body',
      '--repo',
      expectedRepoFullName,
    ],
    withHiddenGhCliWindow({ cwd: repoRoot, timeout: 30_000 }),
  );
  return JSON.parse(result.stdout) as OpenVerdictPr[];
}

async function git(repoRoot: string, args: string[], timeout = 60_000) {
  return exec('git', ['-C', repoRoot, ...args], { timeout });
}

async function gitSucceeds(repoRoot: string, args: string[]): Promise<boolean> {
  try {
    await git(repoRoot, args);
    return true;
  } catch {
    return false;
  }
}

function assertTargetScope(paths: string[], verdictId: string): void {
  const exact = new Set([`docs/harness-feedback/verdicts/${verdictId}.md`, MEASUREMENT_BUNDLE_CENSUS_REF]);
  const prefixes = [
    `docs/harness-feedback/bundles/${verdictId}/`,
    `generated/capability-wakeup/${verdictId}/`,
    `generated/memory/${verdictId}/`,
    `generated/sop/${verdictId}/`,
  ];
  const outside = paths.filter((path) => !exact.has(path) && !prefixes.some((prefix) => path.startsWith(prefix)));
  if (outside.length > 0) {
    throw new Error(`verdict_pr_scope_invalid: ${outside.join(', ')}`);
  }
}

async function assertRefScope(repoRoot: string, diffRange: string, verdictId: string): Promise<void> {
  const changedPaths = (await git(repoRoot, ['diff', '--name-only', diffRange])).stdout.split('\n').filter(Boolean);
  assertTargetScope(changedPaths, verdictId);
}

async function resolveRefreshContext(
  deps: GitVerdictPrRefresherDeps,
  opts: RefreshPublishedVerdictPrOpts,
  resolveOpenPr: (branchName: string) => Promise<OpenVerdictPr[]>,
) {
  const remoteBranch = `refs/remotes/origin/${opts.branchName}`;
  await git(deps.repoRoot, ['fetch', 'origin', 'main', `refs/heads/${opts.branchName}:${remoteBranch}`]);
  const branchHead = (await git(deps.repoRoot, ['rev-parse', remoteBranch])).stdout.trim();
  const baseSha = (await git(deps.repoRoot, ['rev-parse', 'origin/main'])).stdout.trim();
  if (branchHead !== opts.expectedHeadSha) {
    throw new Error(`verdict_pr_head_mismatch: expected ${opts.expectedHeadSha}, found ${branchHead}`);
  }

  const prs = await resolveOpenPr(opts.branchName);
  if (prs.length === 0) throw new Error(`verdict_pr_not_found: no open PR for ${opts.branchName}`);
  if (prs.length !== 1) throw new Error(`verdict_pr_ambiguous: found ${prs.length} open PRs for ${opts.branchName}`);
  const pr = prs[0];
  if (
    pr.headRefName !== opts.branchName ||
    pr.baseRefName !== 'main' ||
    pr.headRefOid !== branchHead ||
    !pr.body.includes(PUBLISH_MARKER)
  ) {
    throw new Error('verdict_pr_scope_invalid: PR identity/provenance does not match the auto-verdict contract');
  }

  await assertRefScope(deps.repoRoot, `origin/main...${remoteBranch}`, opts.verdictId);
  const localBranch = await resolveLocalBranchOwnership(deps.repoRoot, opts.branchName, branchHead);
  return { remoteBranch, branchHead, baseSha, pr, localBranch };
}

async function updateVerdictBranch(
  repoRoot: string,
  worktreePath: string,
  pushRepoPath: string,
  opts: RefreshPublishedVerdictPrOpts,
  context: Awaited<ReturnType<typeof resolveRefreshContext>>,
  expectedRepoFullName: string,
  beforeAttachLocalBranch?: GitVerdictPrRefresherDeps['beforeAttachLocalBranch'],
  beforePreparePinnedPush?: GitVerdictPrRefresherDeps['beforePreparePinnedPush'],
  contractRunner: VerdictPublishContractRunner = runVerdictPublishContract,
  commitStatusPublisher: (input: PublishVerdictCommitStatusesInput) => Promise<void> = publishVerdictCommitStatuses,
): Promise<RefreshPublishedVerdictPrResult> {
  // Keep the refresh worktree attached to the verdict branch so the subsequent
  // push is a same-branch update rather than a detached HEAD -> named branch
  // cross-push. Production pre-push guards correctly block the detached form.
  // Branch creation ownership is acquired before this point; worktree attach
  // now always binds to an already-proven local branch.
  await beforeAttachLocalBranch?.({ repoRoot, branchName: opts.branchName, branchHead: context.branchHead });
  await git(repoRoot, ['worktree', 'add', worktreePath, opts.branchName]);
  const attachedHead = (await git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
  if (attachedHead !== context.branchHead) {
    throw new Error(`verdict_pr_head_mismatch: expected ${context.branchHead}, found ${attachedHead}`);
  }
  let mergeHadConflict = false;
  try {
    await git(worktreePath, ['merge', '--no-commit', '--no-ff', 'origin/main']);
  } catch {
    mergeHadConflict = true;
  }
  if (mergeHadConflict) {
    const conflicts = (await git(worktreePath, ['diff', '--name-only', '--diff-filter=U'])).stdout
      .split('\n')
      .filter(Boolean);
    if (conflicts.length !== 1 || conflicts[0] !== MEASUREMENT_BUNDLE_CENSUS_REF) {
      throw new Error(
        `verdict_pr_refresh_conflict: ${conflicts.join(', ') || 'merge failed without a census conflict'}`,
      );
    }
  }

  const mainHasCensus = await gitSucceeds(worktreePath, [
    'cat-file',
    '-e',
    `origin/main:${MEASUREMENT_BUNDLE_CENSUS_REF}`,
  ]);
  if (mainHasCensus) {
    await git(worktreePath, ['checkout', 'origin/main', '--', MEASUREMENT_BUNDLE_CENSUS_REF]);
  } else if (mergeHadConflict) {
    await git(worktreePath, ['checkout', '--ours', '--', MEASUREMENT_BUNDLE_CENSUS_REF]);
  }
  if (!existsSync(resolve(worktreePath, MEASUREMENT_BUNDLE_CENSUS_REF))) {
    throw new Error('verdict_pr_census_missing: neither origin/main nor the verdict branch has an instance census');
  }
  const cleanCensusSource = readFileSync(resolve(worktreePath, MEASUREMENT_BUNDLE_CENSUS_REF), 'utf8');
  const refreshedPath = opts.refreshDerivedCensus(worktreePath, opts.generatedAt, cleanCensusSource);
  await git(worktreePath, ['add', '--', refreshedPath]);
  await git(worktreePath, [
    'commit',
    '--no-verify',
    '-m',
    `chore(eval): refresh ${opts.verdictId} census on latest main`,
  ]);
  const commitSha = (await git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
  await assertRefScope(worktreePath, `origin/main...${commitSha}`, opts.verdictId);
  const currentHeadBeforePush = (await git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
  if (currentHeadBeforePush !== commitSha) {
    throw new Error(`verdict_pr_head_mismatch: expected ${commitSha}, found ${currentHeadBeforePush}`);
  }
  await publishRefreshedVerdictCommit({
    repoRoot,
    worktreePath,
    pushRepoPath,
    expectedRepoFullName,
    branchName: opts.branchName,
    previousHeadSha: context.branchHead,
    commitSha,
    contractRunner,
    commitStatusPublisher,
    beforePreparePinnedPush,
  });
  return {
    outcome: 'updated',
    previousHeadSha: context.branchHead,
    commitSha,
    baseSha: context.baseSha,
    prUrl: context.pr.url,
  };
}

export function createGitVerdictPrRefresher(deps: GitVerdictPrRefresherDeps) {
  return async function refreshPublishedVerdictPr(
    opts: RefreshPublishedVerdictPrOpts,
  ): Promise<RefreshPublishedVerdictPrResult> {
    await verifyPublisherIdentity(deps);
    const resolveOpenPr = resolveConfiguredOpenPr(deps);
    const tempRoot = mkdtempSync(`${tmpdir()}/cat-cafe-refresh-verdict-${process.pid}-`);
    // Git keys worktree administration by the target basename. Keep that basename
    // unique as well as the parent so concurrent refreshes cannot collide.
    const worktreePath = resolve(tempRoot, `worktree-${randomUUID()}`);
    const pushRepoPath = resolve(tempRoot, `push-${randomUUID()}`);
    let context: Awaited<ReturnType<typeof resolveRefreshContext>> | null = null;
    let createdLocalBranch = false;
    let ownedLocalBranchHead: string | null = null;

    try {
      context = await resolveRefreshContext(deps, opts, resolveOpenPr);
      const current = await gitSucceeds(deps.repoRoot, [
        'merge-base',
        '--is-ancestor',
        'origin/main',
        context.remoteBranch,
      ]);
      if (current) {
        return {
          outcome: 'already_current',
          previousHeadSha: context.branchHead,
          commitSha: context.branchHead,
          baseSha: context.baseSha,
          prUrl: context.pr.url,
        };
      }
      const localBranch = await acquireLocalBranchForRefresh(
        deps.repoRoot,
        opts.branchName,
        context.branchHead,
        context.localBranch,
        deps.beforeAcquireLocalBranch,
      );
      createdLocalBranch = localBranch.createdByRefresh;
      if (createdLocalBranch) {
        ownedLocalBranchHead = context.branchHead;
      }
      const result = await updateVerdictBranch(
        deps.repoRoot,
        worktreePath,
        pushRepoPath,
        opts,
        context,
        deps.expectedRepoFullName,
        deps.beforeAttachLocalBranch,
        deps.beforePreparePinnedPush,
        deps.contractRunner,
        deps.commitStatusPublisher,
      );
      if (createdLocalBranch) {
        ownedLocalBranchHead = result.commitSha;
      }
      return result;
    } finally {
      try {
        await git(deps.repoRoot, ['worktree', 'remove', '--force', worktreePath], 30_000);
      } catch {
        // Worktree may not have been registered yet.
      }
      if (createdLocalBranch && ownedLocalBranchHead) {
        try {
          await deleteOwnedLocalBranch(deps.repoRoot, opts.branchName, ownedLocalBranchHead);
        } catch {
          // Best-effort cleanup for the refresh-owned local branch backing the worktree.
        }
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  };
}
