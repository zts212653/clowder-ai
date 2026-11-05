import {
  decodePullRequestChangesTarget,
  encodePullRequestChangesTarget,
  type PullRequestChangesTarget,
  parsePullRequestChangesTarget,
  parsePullRequestFullRef,
  pullRequestChangesObjectId,
  type ThreadArtifactDTO,
} from '@cat-cafe/shared';
import { SURFACE_CAPABILITIES } from './real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

export const PULL_REQUEST_CHANGES_OWNER = 'f063-workspace-diff';

export function createPullRequestChangesSurface(input: {
  artifact: Pick<ThreadArtifactDTO, 'type' | 'ref' | 'name'>;
  worktreeId: string | null;
  threadId?: string | null;
  navigationOrigin?: WorkspaceSurfaceDescriptor['navigationOrigin'];
}): WorkspaceSurfaceDescriptor | null {
  if (input.artifact.type !== 'pr') return null;
  const ref = parsePullRequestFullRef(input.artifact.ref);
  if (!ref) return null;
  const target = parsePullRequestChangesTarget({
    kind: 'github-pr',
    v: 1,
    ...ref,
    worktreeId: input.worktreeId,
    threadId: input.threadId ?? null,
  });
  if (!target) return null;
  const objectId = pullRequestChangesObjectId(target);
  return {
    id: `workspace:${objectId}`,
    type: 'workspace',
    renderer: 'workspace-destination',
    title: `${target.repoFullName}#${target.prNumber}`,
    context: input.artifact.name,
    objectRef: { kind: 'workspace-destination', id: objectId },
    ownerStateRef: { owner: PULL_REQUEST_CHANGES_OWNER, key: target.worktreeId },
    resultTargetRef: { owner: PULL_REQUEST_CHANGES_OWNER, key: encodePullRequestChangesTarget(target) },
    capabilities: SURFACE_CAPABILITIES,
    ...(input.navigationOrigin ? { navigationOrigin: input.navigationOrigin } : {}),
  };
}

export function isPullRequestChangesSurfaceCandidate(surface: WorkspaceSurfaceDescriptor): boolean {
  return (
    surface.id.startsWith('workspace:surface:changes:pr:') || surface.objectRef.id.startsWith('surface:changes:pr:')
  );
}

export function resolvePullRequestChangesTarget(surface: WorkspaceSurfaceDescriptor): PullRequestChangesTarget | null {
  if (
    surface.type !== 'workspace' ||
    surface.renderer !== 'workspace-destination' ||
    surface.objectRef.kind !== 'workspace-destination' ||
    surface.ownerStateRef.owner !== PULL_REQUEST_CHANGES_OWNER ||
    surface.resultTargetRef?.owner !== PULL_REQUEST_CHANGES_OWNER
  )
    return null;
  const target = decodePullRequestChangesTarget(surface.resultTargetRef.key);
  if (!target || target.worktreeId !== surface.ownerStateRef.key) return null;
  const objectId = pullRequestChangesObjectId(target);
  return surface.objectRef.id === objectId && surface.id === `workspace:${objectId}` ? target : null;
}
