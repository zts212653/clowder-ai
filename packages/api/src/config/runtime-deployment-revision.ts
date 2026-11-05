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

/**
 * Direct launches can identify their own build without owning a deployment ledger.
 * Managed launches still obtain their revision from the validated boot context.
 * Read once at startup: later builds on disk do not change the running process.
 */
export function resolveInitialBuildRevision(input: {
  entrypointRoot: string;
  declaredRuntimeRoot: string | undefined;
  declaredDeploymentId: string | undefined;
}): string | null {
  if (input.declaredRuntimeRoot && input.declaredDeploymentId) return null;
  return resolveRuntimeDeploymentRevision(input.entrypointRoot);
}
