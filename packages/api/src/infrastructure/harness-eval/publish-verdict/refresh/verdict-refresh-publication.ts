import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type PublishVerdictCommitStatusesInput,
  verdictEvidenceContractSuccessStatuses,
} from '../publication/verdict-commit-status-publisher.js';
import type { VerdictPublishContractRunner } from '../publication/verdict-publish-contract-runner.js';

const exec = promisify(execFile);

type CommitStatusPublisher = (input: PublishVerdictCommitStatusesInput) => Promise<void>;

export interface PublishRefreshedVerdictCommitInput {
  repoRoot: string;
  worktreePath: string;
  pushRepoPath: string;
  expectedRepoFullName: string;
  branchName: string;
  previousHeadSha: string;
  commitSha: string;
  contractRunner: VerdictPublishContractRunner;
  commitStatusPublisher: CommitStatusPublisher;
  beforePreparePinnedPush?: (args: {
    repoRoot: string;
    worktreePath: string;
    branchName: string;
    branchHead: string;
    commitSha: string;
  }) => Promise<void>;
}

async function git(repoRoot: string, args: string[], timeout = 60_000) {
  return exec('git', ['-C', repoRoot, ...args], { timeout });
}

async function resolveEffectiveHooksPath(repoRoot: string): Promise<string> {
  return (await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'])).stdout.trim();
}

async function pushValidatedCommitFromPinnedBranch(input: PublishRefreshedVerdictCommitInput): Promise<void> {
  const originUrl = (await git(input.repoRoot, ['remote', 'get-url', 'origin'])).stdout.trim();
  const hooksPath = await resolveEffectiveHooksPath(input.repoRoot);
  const sourceCheckoutRoot = (await git(input.repoRoot, ['rev-parse', '--show-toplevel'])).stdout.trim();
  await exec('git', ['clone', '--no-checkout', '--shared', input.repoRoot, input.pushRepoPath], {
    timeout: 60_000,
  });
  await git(input.pushRepoPath, ['remote', 'set-url', 'origin', originUrl]);
  await git(input.pushRepoPath, ['config', 'core.hooksPath', hooksPath]);
  await git(input.pushRepoPath, ['config', 'catcafe.verdictSourceRoot', sourceCheckoutRoot]);
  await git(input.pushRepoPath, ['update-ref', `refs/heads/${input.branchName}`, input.commitSha]);
  const pinnedHead = (await git(input.pushRepoPath, ['rev-parse', `refs/heads/${input.branchName}`])).stdout.trim();
  if (pinnedHead !== input.commitSha) {
    throw new Error(`verdict_pr_head_mismatch: expected ${input.commitSha}, found ${pinnedHead}`);
  }
  await git(
    input.pushRepoPath,
    ['push', '-u', 'origin', `refs/heads/${input.branchName}:refs/heads/${input.branchName}`],
    120_000,
  );
}

async function restorePreviousHead(input: PublishRefreshedVerdictCommitInput): Promise<void> {
  const branchRef = `refs/heads/${input.branchName}`;
  await git(input.pushRepoPath, ['update-ref', branchRef, input.previousHeadSha, input.commitSha]);
  // The old HEAD already passed the publication guard when its PR was created.
  // This lease-protected compensation exposes no new evidence; running the
  // pre-push hook against a reverse diff would misclassify the rollback itself.
  await git(
    input.pushRepoPath,
    [
      'push',
      '--no-verify',
      `--force-with-lease=${branchRef}:${input.commitSha}`,
      'origin',
      `${branchRef}:${branchRef}`,
    ],
    120_000,
  );
  const remoteLine = (await git(input.pushRepoPath, ['ls-remote', 'origin', branchRef])).stdout.trim();
  const remoteHead = remoteLine.split(/\s+/)[0] ?? '';
  if (remoteHead !== input.previousHeadSha) {
    throw new Error(`verdict_pr_rollback_mismatch: expected ${input.previousHeadSha}, found ${remoteHead}`);
  }

  const localHead = (await git(input.repoRoot, ['rev-parse', '--verify', branchRef])).stdout.trim();
  if (localHead === input.commitSha) {
    await git(input.repoRoot, ['update-ref', branchRef, input.previousHeadSha, input.commitSha]);
  }
}

export async function publishRefreshedVerdictCommit(input: PublishRefreshedVerdictCommitInput): Promise<void> {
  await input.contractRunner({
    repoRoot: input.worktreePath,
    implementationRoot: input.repoRoot,
    expectedRepoFullName: input.expectedRepoFullName,
    remoteName: 'origin',
    baseRef: 'origin/main',
    sourceRef: 'HEAD',
  });
  await input.beforePreparePinnedPush?.({
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    branchHead: input.previousHeadSha,
    commitSha: input.commitSha,
  });
  await pushValidatedCommitFromPinnedBranch(input);
  try {
    await input.commitStatusPublisher({
      repoFullName: input.expectedRepoFullName,
      headSha: input.commitSha,
      statuses: verdictEvidenceContractSuccessStatuses(),
    });
  } catch (error) {
    try {
      await restorePreviousHead(input);
    } catch (cleanupError) {
      const original = error instanceof Error ? error.message : String(error);
      const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(`verdict_refresh_status_cleanup_failed: original=${original}; cleanup=${cleanup}`);
    }
    throw error;
  }
}
