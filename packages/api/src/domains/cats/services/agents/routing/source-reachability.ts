import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolvePersistentProjectPath } from '../../../../../utils/persistent-project-path.js';
import { isPathUnderRoots } from '../../../../../utils/project-path.js';
import type { RecentArtifact } from './artifact-tracking.js';

function isLocalArtifact(artifact: RecentArtifact): boolean {
  return artifact.type === 'file' || artifact.type === 'plan' || artifact.type === 'feature-doc';
}

/**
 * Resolve local artifact refs against the canonical thread workspace.
 * Missing paths, invalid roots, and symlink escapes all fail closed.
 */
export async function resolveReachableArtifactRefs(
  projectPath: string | undefined,
  artifacts: readonly RecentArtifact[],
): Promise<ReadonlySet<string>> {
  const reachable = new Set<string>();
  if (!projectPath || projectPath === 'default' || projectPath.startsWith('games/')) return reachable;

  const projectRoot = await resolvePersistentProjectPath(projectPath);
  if (!projectRoot) return reachable;

  await Promise.all(
    artifacts.filter(isLocalArtifact).map(async (artifact) => {
      try {
        const candidate = await realpath(resolve(projectRoot, artifact.ref));
        if (isPathUnderRoots(candidate, [projectRoot])) reachable.add(artifact.ref);
      } catch {
        // Missing/unreadable artifacts are intentionally ineligible for directive presentation.
      }
    }),
  );

  return reachable;
}
