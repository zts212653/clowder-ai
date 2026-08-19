import { execFileSync } from 'node:child_process';

const COMMIT_SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export interface EvalReleaseGit {
  resolveCommit(revision: string): string;
  isAncestor(ancestor: string, descendant: string): boolean;
}

export interface VerifiedEvalReleaseFact {
  commitSha: string;
  evidenceRef: string;
}

export interface EvalReleaseTruthResolver {
  readonly loadedRuntimeHead: string | undefined;
  verifyMainLanded(commitSha: string): VerifiedEvalReleaseFact;
  verifyLiveActive(commitSha: string): VerifiedEvalReleaseFact;
}

export class EvalReleaseTruthError extends Error {
  constructor(
    readonly code: 'invalid_commit' | 'commit_unavailable' | 'main_not_landed' | 'live_not_active',
    message: string,
  ) {
    super(message);
    this.name = 'EvalReleaseTruthError';
  }
}

function createRealGit(repoRoot: string): EvalReleaseGit {
  const run = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  return {
    resolveCommit(revision) {
      return run(['rev-parse', '--verify', `${revision}^{commit}`]);
    },
    isAncestor(ancestor, descendant) {
      try {
        run(['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'status' in error && error.status === 1) return false;
        throw error;
      }
    },
  };
}

function requireCommitInput(commitSha: string): void {
  if (!COMMIT_SHA.test(commitSha)) {
    throw new EvalReleaseTruthError('invalid_commit', 'release commit must be a full lowercase Git commit SHA');
  }
}

function resolveCommit(git: EvalReleaseGit, revision: string, label: string): string {
  try {
    const resolved = git.resolveCommit(revision);
    if (!COMMIT_SHA.test(resolved)) throw new Error(`resolved value is not a full commit SHA: ${resolved}`);
    return resolved;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new EvalReleaseTruthError('commit_unavailable', `cannot resolve ${label}: ${detail}`);
  }
}

function createUnavailableResolver(error: EvalReleaseTruthError): EvalReleaseTruthResolver {
  const rejectUnavailable = (commitSha: string): never => {
    requireCommitInput(commitSha);
    throw new EvalReleaseTruthError('commit_unavailable', error.message);
  };
  return {
    loadedRuntimeHead: undefined,
    verifyMainLanded: rejectUnavailable,
    verifyLiveActive: rejectUnavailable,
  };
}

export function createEvalReleaseTruthResolver(options: {
  repoRoot?: string;
  git?: EvalReleaseGit;
  loadedRuntimeHead?: string;
}): EvalReleaseTruthResolver {
  if (!options.git && !options.repoRoot) throw new Error('repoRoot is required when no Git adapter is supplied');
  const git = options.git ?? createRealGit(options.repoRoot as string);
  let loadedRuntimeHead: string;
  try {
    loadedRuntimeHead = resolveCommit(git, options.loadedRuntimeHead ?? 'HEAD', 'loaded runtime HEAD');
  } catch (error) {
    if (error instanceof EvalReleaseTruthError && error.code === 'commit_unavailable') {
      return createUnavailableResolver(error);
    }
    throw error;
  }

  return {
    loadedRuntimeHead,
    verifyMainLanded(commitSha) {
      requireCommitInput(commitSha);
      const canonicalCommit = resolveCommit(git, commitSha, `release commit ${commitSha}`);
      const mainHead = resolveCommit(git, 'origin/main', 'origin/main');
      if (!git.isAncestor(canonicalCommit, mainHead)) {
        throw new EvalReleaseTruthError(
          'main_not_landed',
          `commit ${canonicalCommit} is not landed on origin/main ${mainHead}`,
        );
      }
      return {
        commitSha: canonicalCommit,
        evidenceRef: `git:origin/main@${mainHead}:contains:${canonicalCommit}`,
      };
    },
    verifyLiveActive(commitSha) {
      requireCommitInput(commitSha);
      const canonicalCommit = resolveCommit(git, commitSha, `release commit ${commitSha}`);
      if (!git.isAncestor(canonicalCommit, loadedRuntimeHead)) {
        throw new EvalReleaseTruthError(
          'live_not_active',
          `commit ${canonicalCommit} is not active in loaded runtime ${loadedRuntimeHead}`,
        );
      }
      return {
        commitSha: canonicalCommit,
        evidenceRef: `runtime:${loadedRuntimeHead}:contains:${canonicalCommit}`,
      };
    },
  };
}
