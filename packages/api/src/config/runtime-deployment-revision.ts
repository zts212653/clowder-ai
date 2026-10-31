import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/;

function readBuildCommit(path: string): string | null {
  try {
    const revision = readFileSync(path, 'utf8').trim().toLowerCase();
    return FULL_GIT_COMMIT.test(revision) ? revision : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the revision shared by the API binary and Web bundle in one deploy.
 *
 * Runtime startup writes both stamps after their production builds. Returning
 * null on missing/malformed/mismatched stamps keeps development and partial
 * builds from inventing deployment identity.
 */
export function resolveRuntimeDeploymentRevision(runtimeRoot: string | undefined): string | null {
  if (!runtimeRoot) return null;
  const apiRevision = readBuildCommit(resolve(runtimeRoot, 'packages/api/dist/.build-commit'));
  const webRevision = readBuildCommit(resolve(runtimeRoot, 'packages/web/.next/.build-commit'));
  if (!apiRevision || apiRevision !== webRevision) return null;
  return apiRevision;
}
