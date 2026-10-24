import type { PullRequestChangesData, PullRequestChangesTarget } from '@cat-cafe/shared';
import { buildGhCliEnv } from '../../infrastructure/github/gh-cli-env.js';
import { executeGitHubProcess } from '../../infrastructure/github/gh-process.js';
import { classifyGhValidationFailure } from '../../infrastructure/github/github-object-validator.js';
import { readPullRequestFiles } from './pull-request-changes-files.js';
import { getWorktreeRoot, WorkspaceSecurityError } from './workspace-security.js';

// Transport and rendered patch budgets are different: JSON escaping can expand
// each character sixfold. Two further rendered budgets bound metadata and hunks
// omitted from the final 2 MiB view. Larger responses remain honestly unavailable.
const COMPARISON_ENVELOPE_LIMIT = 8 * 2 * 1024 * 1024;

export interface PullRequestChangesDependencies {
  resolveRoot?: typeof getWorktreeRoot;
  execute?: typeof executeGitHubProcess;
  /** Set only by the authenticated chat read adapter; it grants no local file access. */
  allowForeignRepository?: boolean;
}

export class PullRequestChangesReadError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(code);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response');
  return value as Record<string, unknown>;
}
function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new Error('Invalid SHA');
  return value;
}
export function repositoryFromRemote(remote: string): string | null {
  const value = remote.trim();
  const match =
    /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      value,
    );
  return match?.[1]?.toLowerCase() ?? null;
}

export async function readPullRequestChanges(
  target: PullRequestChangesTarget,
  dependencies: PullRequestChangesDependencies = {},
): Promise<PullRequestChangesData> {
  let root: string;
  try {
    root = await (dependencies.resolveRoot ?? getWorktreeRoot)(target.worktreeId);
  } catch (error) {
    if (error instanceof WorkspaceSecurityError)
      throw new PullRequestChangesReadError('root_unavailable', error.code === 'NOT_FOUND' ? 404 : 403);
    throw new PullRequestChangesReadError('root_unavailable', 503);
  }
  const execute = dependencies.execute ?? executeGitHubProcess;
  const deadline = Date.now() + 20_000;
  async function run(command: string, args: string[], maxBuffer: number): Promise<string> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new PullRequestChangesReadError('unavailable', 503);
    return (
      await execute(command, args, {
        timeout: Math.min(10_000, remaining),
        maxBuffer,
        windowsHide: true,
        ...(command === 'gh' ? { env: buildGhCliEnv() } : {}),
      })
    ).stdout;
  }
  try {
    if (!dependencies.allowForeignRepository) {
      const remote = await run('git', ['-C', root, 'remote', 'get-url', 'origin'], 4096);
      if (repositoryFromRemote(remote) !== target.repoFullName)
        throw new PullRequestChangesReadError('repository_mismatch', 409);
    }
    const pull = object(
      JSON.parse(await run('gh', ['api', `repos/${target.repoFullName}/pulls/${target.prNumber}`], 256 * 1024)),
    );
    const base = object(pull.base);
    const baseRepository = object(base.repo).full_name;
    if (typeof baseRepository !== 'string' || baseRepository.toLowerCase() !== target.repoFullName)
      throw new PullRequestChangesReadError('repository_mismatch', 409);
    if (
      pull.number !== target.prNumber ||
      typeof pull.changed_files !== 'number' ||
      !Number.isSafeInteger(pull.changed_files) ||
      pull.changed_files < 0
    )
      throw new Error('Invalid PR identity');
    const baseSha = sha(base.sha);
    const headSha = sha(object(pull.head).sha);
    const comparison = object(
      JSON.parse(
        await run(
          'gh',
          ['api', `repos/${target.repoFullName}/compare/${baseSha}...${headSha}?per_page=100&page=1`],
          COMPARISON_ENVELOPE_LIMIT,
        ),
      ),
    );
    if (sha(object(comparison.base_commit).sha) !== baseSha) throw new Error('Invalid comparison base');
    const mergeBaseSha = sha(object(comparison.merge_base_commit).sha);
    return {
      target,
      comparison: { baseSha, headSha, mergeBaseSha },
      ...readPullRequestFiles(comparison.files, pull.changed_files),
    };
  } catch (error) {
    if (error instanceof PullRequestChangesReadError) throw error;
    const kind = classifyGhValidationFailure(error);
    const status = {
      authentication_required: 401,
      permission_denied: 403,
      rate_limited: 429,
      not_found: 404,
      unavailable: 503,
    };
    throw new PullRequestChangesReadError(kind, status[kind]);
  }
}
