import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GitTastePublicationAttempt {
  attempt: number;
  checkoutRoot: string;
  baseSha: string;
  commitSha: string;
}

export interface GitTastePublicationOptions {
  beforePush?: (attempt: GitTastePublicationAttempt) => void | Promise<void>;
  gitCommandTimeoutMs?: number;
}

export interface GitTastePublicationInput {
  sourceRoot: string;
  branchSuffix: string;
  commitMessage: string;
  filesToCommit: string[];
  materialize: (checkoutRoot: string) => 'changed' | 'already-published';
}

export interface GitTastePublicationResult {
  commitSha: string;
  alreadyPublished: boolean;
}

export class TastePublicationIndeterminateError extends Error {
  readonly publicationOutcome = 'indeterminate';

  constructor(message: string) {
    super(message);
    this.name = 'TastePublicationIndeterminateError';
  }
}

export function isTastePublicationIndeterminateError(error: unknown): error is TastePublicationIndeterminateError {
  return (
    error instanceof TastePublicationIndeterminateError ||
    (error instanceof Error && 'publicationOutcome' in error && error.publicationOutcome === 'indeterminate')
  );
}

const GIT_COMMAND_TIMEOUT_MS = 30_000;
const PUBLICATION_ATTEMPTS = 3;

function runGit(cwd: string, args: string[], timeoutMs = GIT_COMMAND_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as Error & { stderr?: Buffer | string }).stderr;
  const detail = typeof stderr === 'string' ? stderr.trim() : stderr?.toString('utf8').trim();
  if (detail) return detail;
  return error.message;
}

function isTerminalPushRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const output = error as Error & { stdout?: Buffer | string; stderr?: Buffer | string };
  const stdout = typeof output.stdout === 'string' ? output.stdout : output.stdout?.toString('utf8');
  const stderr = typeof output.stderr === 'string' ? output.stderr : output.stderr?.toString('utf8');
  const detail = [stdout, stderr].filter(Boolean).join('\n');
  if (!detail) return false;
  return /\[(?:remote )?rejected\]|pre-receive hook declined|non-fast-forward|fetch first|failed to update ref/i.test(
    detail,
  );
}

function sanitizeBranchSuffix(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  if (!sanitized) throw new Error('Taste publication requires a non-empty proposal branch suffix');
  return sanitized;
}

async function prepareCheckout(sourceRoot: string, checkoutRoot: string, branchName: string): Promise<string> {
  const originUrl = await runGit(sourceRoot, ['remote', 'get-url', 'origin']);
  const hooksPath = await runGit(sourceRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  await runGit(sourceRoot, ['clone', '--no-checkout', '--shared', sourceRoot, checkoutRoot]);
  await runGit(checkoutRoot, ['remote', 'set-url', 'origin', originUrl]);
  await runGit(checkoutRoot, ['config', 'core.hooksPath', hooksPath]);
  await runGit(checkoutRoot, ['config', 'user.name', 'Clowder AI Taste Publisher']);
  await runGit(checkoutRoot, ['config', 'user.email', 'taste-publisher@cat-cafe.local']);
  await runGit(checkoutRoot, ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  const baseSha = await runGit(checkoutRoot, ['rev-parse', 'refs/remotes/origin/main']);
  await runGit(checkoutRoot, ['checkout', '-b', branchName, baseSha]);
  return baseSha;
}

async function inspectRemoteProjection(
  checkoutRoot: string,
  previousBaseSha: string,
  input: GitTastePublicationInput,
): Promise<{ advanced: boolean; projectionCommitSha?: string }> {
  await runGit(checkoutRoot, ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  const remoteSha = await runGit(checkoutRoot, ['rev-parse', 'refs/remotes/origin/main']);
  await runGit(checkoutRoot, ['reset', '--hard', remoteSha]);
  if (input.materialize(checkoutRoot) === 'already-published') {
    return {
      advanced: remoteSha !== previousBaseSha,
      projectionCommitSha: await findExistingProjectionCommit(checkoutRoot, input.filesToCommit[0]),
    };
  }
  return { advanced: remoteSha !== previousBaseSha };
}

async function findExistingProjectionCommit(checkoutRoot: string, firstPath: string): Promise<string> {
  return (
    (await runGit(checkoutRoot, ['log', '-1', '--format=%H', '--', firstPath])) ||
    (await runGit(checkoutRoot, ['rev-parse', 'HEAD']))
  );
}

async function resolveFailedPush(
  pushError: unknown,
  checkoutRoot: string,
  baseSha: string,
  attempt: number,
  input: GitTastePublicationInput,
): Promise<GitTastePublicationResult | 'retry'> {
  let remoteState: Awaited<ReturnType<typeof inspectRemoteProjection>>;
  try {
    remoteState = await inspectRemoteProjection(checkoutRoot, baseSha, input);
  } catch (confirmationError) {
    throw new TastePublicationIndeterminateError(
      `Taste publication push outcome could not be confirmed: ${errorMessage(confirmationError)}`,
    );
  }
  if (remoteState.projectionCommitSha) {
    return { commitSha: remoteState.projectionCommitSha, alreadyPublished: true };
  }
  if (!isTerminalPushRejection(pushError)) {
    throw new TastePublicationIndeterminateError(
      `Taste publication push ended without terminal rejection proof: ${errorMessage(pushError)}`,
    );
  }
  if (attempt < PUBLICATION_ATTEMPTS && remoteState.advanced) return 'retry';
  throw pushError;
}

/**
 * Publish one public Taste projection from a disposable named branch.
 *
 * The primary main worktree is never read as a base or mutated. A successful
 * return means the exact commit reached origin/main. A verified concurrent
 * remote advance rebuilds the projection from the winner and retries.
 */
export async function publishTasteProjection(
  input: GitTastePublicationInput,
  options: GitTastePublicationOptions = {},
): Promise<GitTastePublicationResult> {
  const branchName = `taste/publish-${sanitizeBranchSuffix(input.branchSuffix)}`;

  for (let attempt = 1; attempt <= PUBLICATION_ATTEMPTS; attempt++) {
    const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-taste-publish-'));
    const checkoutRoot = join(tempRoot, 'repo');
    try {
      const baseSha = await prepareCheckout(input.sourceRoot, checkoutRoot, branchName);
      const materialized = input.materialize(checkoutRoot);
      if (materialized === 'already-published') {
        return {
          commitSha: await findExistingProjectionCommit(checkoutRoot, input.filesToCommit[0]),
          alreadyPublished: true,
        };
      }

      await runGit(checkoutRoot, ['add', '--', ...input.filesToCommit]);
      await runGit(checkoutRoot, ['commit', '--only', '-m', input.commitMessage, '--', ...input.filesToCommit]);
      const commitSha = await runGit(checkoutRoot, ['rev-parse', 'HEAD']);
      await options.beforePush?.({ attempt, checkoutRoot, baseSha, commitSha });

      try {
        await runGit(
          checkoutRoot,
          ['push', '--porcelain', 'origin', `${branchName}:refs/heads/main`],
          options.gitCommandTimeoutMs,
        );
      } catch (pushError) {
        const resolution = await resolveFailedPush(pushError, checkoutRoot, baseSha, attempt, input);
        if (resolution === 'retry') continue;
        return resolution;
      }
      return { commitSha, alreadyPublished: false };
    } catch (error) {
      if (isTastePublicationIndeterminateError(error)) throw error;
      throw new Error(`Taste publication failed: ${errorMessage(error)}`);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  throw new Error(`Taste publication failed after ${PUBLICATION_ATTEMPTS} attempts`);
}
