import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ZERO_OID = '0'.repeat(40);

export interface OpenVerdictPr {
  url: string;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  body: string;
}

export interface LocalBranchOwnership {
  existedBefore: boolean;
  branchHead?: string;
}

export interface LocalBranchAcquisition {
  localBranch: LocalBranchOwnership;
  createdByRefresh: boolean;
}

type BeforeAcquireLocalBranch = (args: { repoRoot: string; branchName: string; branchHead: string }) => Promise<void>;

async function git(repoRoot: string, args: string[], timeout = 60_000) {
  return exec('git', ['-C', repoRoot, ...args], { timeout });
}

function parseWorktreePathForBranch(porcelain: string, branchName: string): string | null {
  const branchRef = `refs/heads/${branchName}`;
  const entries = porcelain
    .trim()
    .split('\n\n')
    .map((entry) => entry.split('\n').filter(Boolean));
  for (const entry of entries) {
    let path: string | null = null;
    let branch: string | null = null;
    for (const line of entry) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      if (line.startsWith('branch ')) branch = line.slice('branch '.length);
    }
    if (path && branch === branchRef) return path;
  }
  return null;
}

export async function resolveLocalBranchOwnership(
  repoRoot: string,
  branchName: string,
  expectedHeadSha: string,
): Promise<LocalBranchOwnership> {
  let branchHead: string;
  try {
    branchHead = (await git(repoRoot, ['rev-parse', '--verify', `refs/heads/${branchName}`])).stdout.trim();
  } catch {
    return { existedBefore: false };
  }
  if (branchHead !== expectedHeadSha) {
    throw new Error(
      `verdict_pr_local_branch_conflict: local branch ${branchName} points to ${branchHead}, expected ${expectedHeadSha}`,
    );
  }
  const worktreeList = (await git(repoRoot, ['worktree', 'list', '--porcelain'])).stdout;
  const checkedOutPath = parseWorktreePathForBranch(worktreeList, branchName);
  if (checkedOutPath) {
    throw new Error(
      `verdict_pr_local_branch_conflict: local branch ${branchName} is already checked out at ${checkedOutPath}`,
    );
  }
  return { existedBefore: true, branchHead };
}

export async function acquireLocalBranchForRefresh(
  repoRoot: string,
  branchName: string,
  branchHead: string,
  existingOwnership: LocalBranchOwnership,
  beforeAcquireLocalBranch?: BeforeAcquireLocalBranch,
): Promise<LocalBranchAcquisition> {
  if (existingOwnership.existedBefore) {
    return { localBranch: existingOwnership, createdByRefresh: false };
  }
  await beforeAcquireLocalBranch?.({ repoRoot, branchName, branchHead });
  const branchRef = `refs/heads/${branchName}`;
  try {
    await git(repoRoot, ['update-ref', branchRef, branchHead, ZERO_OID]);
    return { localBranch: { existedBefore: false, branchHead }, createdByRefresh: true };
  } catch (error) {
    const ownership = await resolveLocalBranchOwnership(repoRoot, branchName, branchHead);
    if (ownership.existedBefore) return { localBranch: ownership, createdByRefresh: false };
    throw error;
  }
}

export async function deleteOwnedLocalBranch(
  repoRoot: string,
  branchName: string,
  expectedHeadSha: string,
): Promise<void> {
  const worktreeList = (await git(repoRoot, ['worktree', 'list', '--porcelain'])).stdout;
  if (parseWorktreePathForBranch(worktreeList, branchName)) return;
  await git(repoRoot, ['update-ref', '-d', `refs/heads/${branchName}`, expectedHeadSha], 10_000);
}
