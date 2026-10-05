import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DeploymentInclusionProofV1 } from '@cat-cafe/shared';

const FULL_REVISION = /^[0-9a-f]{40}$/;

export interface RuntimeDeploymentCandidate {
  readonly revision: string;
  readonly observedAt: number;
}

function git(root: string, args: readonly string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((done) => {
    execFile(
      'git',
      [...args],
      { cwd: root, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        done({ code, stdout: stdout.trim() });
      },
    );
  });
}

/**
 * Proof for the build captured by this process, not today's checkout HEAD.
 * A missing object, shallow negative, or Git-less installation is unknown.
 */
export async function resolveRuntimeDeploymentInclusionProof(input: {
  readonly runtimeRoot: string;
  readonly targetRevision: string;
  readonly runningRevision: string;
}): Promise<DeploymentInclusionProofV1 | null> {
  const { runtimeRoot, targetRevision, runningRevision } = input;
  if (!FULL_REVISION.test(targetRevision) || !FULL_REVISION.test(runningRevision)) return null;

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolve(runtimeRoot));
  } catch {
    return null;
  }
  const toplevel = await git(canonicalRoot, ['rev-parse', '--show-toplevel']);
  if (toplevel.code !== 0) return null;
  try {
    if ((await realpath(toplevel.stdout)) !== canonicalRoot) return null;
  } catch {
    return null;
  }

  const [targetObject, runningObject] = await Promise.all([
    git(canonicalRoot, ['cat-file', '-e', `${targetRevision}^{commit}`]),
    git(canonicalRoot, ['cat-file', '-e', `${runningRevision}^{commit}`]),
  ]);
  if (targetObject.code !== 0 || runningObject.code !== 0) return null;

  const ancestry = await git(canonicalRoot, ['merge-base', '--is-ancestor', targetRevision, runningRevision]);
  if (ancestry.code === 0) return { kind: 'git_ancestry', targetRevision, runningRevision, included: true };
  if (ancestry.code !== 1) return null;

  const shallow = await git(canonicalRoot, ['rev-parse', '--is-shallow-repository']);
  return shallow.code === 0 && shallow.stdout === 'false'
    ? { kind: 'git_ancestry', targetRevision, runningRevision, included: false }
    : null;
}

/**
 * Read the locally observed deploy candidate without fetching or promising that
 * a later restart will still freeze this ref. The timestamp keeps that
 * prediction explicitly bounded to this observation.
 */
export async function resolveRuntimeDeploymentCandidate(
  runtimeRoot: string,
  observedAt = Date.now(),
): Promise<RuntimeDeploymentCandidate | null> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolve(runtimeRoot));
  } catch {
    return null;
  }
  const toplevel = await git(canonicalRoot, ['rev-parse', '--show-toplevel']);
  if (toplevel.code !== 0) return null;
  try {
    if ((await realpath(toplevel.stdout)) !== canonicalRoot) return null;
  } catch {
    return null;
  }
  const candidate = await git(canonicalRoot, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']);
  return candidate.code === 0 && FULL_REVISION.test(candidate.stdout)
    ? { revision: candidate.stdout, observedAt }
    : null;
}
