import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { withHiddenGhCliWindow } from '../../github/gh-cli-env.js';
import { MEASUREMENT_BUNDLE_CENSUS_REF } from '../measurement/measurement-bundle-census-file.js';
import type { RefreshPublishedVerdictPrOpts, RefreshPublishedVerdictPrResult } from './types.js';

const exec = promisify(execFile);
const PUBLISH_MARKER = 'Verdict published via cat_cafe_publish_verdict MCP tool.';

interface OpenVerdictPr {
  url: string;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  body: string;
}

export interface GitVerdictPrRefresherDeps {
  repoRoot: string;
  resolveOpenPr?: (branchName: string) => Promise<OpenVerdictPr[]>;
}

async function defaultResolveOpenPr(repoRoot: string, branchName: string): Promise<OpenVerdictPr[]> {
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

  const changedPaths = (await git(deps.repoRoot, ['diff', '--name-only', `origin/main...${remoteBranch}`])).stdout
    .split('\n')
    .filter(Boolean);
  assertTargetScope(changedPaths, opts.verdictId);
  return { remoteBranch, branchHead, baseSha, pr };
}

async function updateVerdictBranch(
  repoRoot: string,
  worktreePath: string,
  opts: RefreshPublishedVerdictPrOpts,
  context: Awaited<ReturnType<typeof resolveRefreshContext>>,
): Promise<RefreshPublishedVerdictPrResult> {
  await git(repoRoot, ['worktree', 'add', '--detach', worktreePath, context.remoteBranch]);
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

  await git(worktreePath, ['checkout', 'origin/main', '--', MEASUREMENT_BUNDLE_CENSUS_REF]);
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
  await git(worktreePath, ['push', 'origin', `HEAD:refs/heads/${opts.branchName}`], 120_000);
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
    const resolveOpenPr = deps.resolveOpenPr ?? ((branchName) => defaultResolveOpenPr(deps.repoRoot, branchName));
    const tempRoot = mkdtempSync(`${tmpdir()}/cat-cafe-refresh-verdict-${process.pid}-`);
    // Git keys worktree administration by the target basename. Keep that basename
    // unique as well as the parent so concurrent refreshes cannot collide.
    const worktreePath = resolve(tempRoot, `worktree-${randomUUID()}`);

    try {
      const context = await resolveRefreshContext(deps, opts, resolveOpenPr);
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
      return await updateVerdictBranch(deps.repoRoot, worktreePath, opts, context);
    } finally {
      try {
        await git(deps.repoRoot, ['worktree', 'remove', '--force', worktreePath], 30_000);
      } catch {
        // Worktree may not have been registered yet.
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  };
}
