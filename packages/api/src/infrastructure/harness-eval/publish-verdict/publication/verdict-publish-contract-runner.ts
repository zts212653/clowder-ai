import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface VerdictPublishContractInput {
  repoRoot: string;
  implementationRoot: string;
  expectedRepoFullName: string;
  remoteName: string;
  baseRef: string;
  sourceRef: string;
  identityOnly?: boolean;
}

export type VerdictPublishContractRunner = (input: VerdictPublishContractInput) => Promise<void>;

/**
 * Extract the domain error from a child-process ExecFileException.
 *
 * promisify(execFile) wraps non-zero exits as:
 *   "Command failed: <full command>\n<stderr>"
 * The structured error code (e.g. verdict_window_already_published) lives in
 * stderr. We re-throw with stderr as the message so mapPublishVerdictError's
 * startsWith checks work correctly.
 */
function rethrowWithStderr(err: unknown): never {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const stderr = String((err as { stderr: unknown }).stderr).trim();
    if (stderr) {
      const normalized = new Error(stderr);
      normalized.cause = err;
      throw normalized;
    }
  }
  throw err;
}

export async function runVerdictPublishContract(input: VerdictPublishContractInput): Promise<void> {
  const transportScript = resolve(input.repoRoot, 'scripts/check-verdict-publish-contract.mjs');
  try {
    await exec(
      process.execPath,
      [
        transportScript,
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
  } catch (err) {
    rethrowWithStderr(err);
  }

  if (!input.identityOnly && input.sourceRef === 'HEAD') {
    const evidenceScript = resolve(input.implementationRoot, 'scripts/check-verdict-evidence-contract.mjs');
    try {
      await exec(
        process.execPath,
        [
          evidenceScript,
          '--candidate-root',
          input.repoRoot,
          '--api-dist-root',
          resolve(input.implementationRoot, 'packages/api/dist'),
          '--git-root',
          input.repoRoot,
        ],
        { cwd: input.implementationRoot, timeout: 120_000 },
      );
    } catch (err) {
      rethrowWithStderr(err);
    }
  }
}
