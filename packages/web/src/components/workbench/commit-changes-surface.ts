import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { SURFACE_CAPABILITIES } from './real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';
export type CommitChangesTarget = { sha: string; worktreeId: string; threadId: string };
function key(target: CommitChangesTarget) {
  return encodeURIComponent(JSON.stringify([target.sha, target.worktreeId, target.threadId]));
}
export function createCommitChangesSurface(
  target: CommitChangesTarget,
  navigationOrigin?: WorkspaceFileNavigationOrigin,
): WorkspaceSurfaceDescriptor {
  const coordinate = key(target),
    objectId = `surface:changes:commit:${coordinate}`;
  return {
    id: `workspace:${objectId}`,
    type: 'workspace',
    renderer: 'workspace-destination',
    title: target.sha.slice(0, 10),
    context: 'Git',
    objectRef: { kind: 'workspace-destination', id: objectId },
    ownerStateRef: { owner: 'f063-workspace-diff', key: target.worktreeId },
    resultTargetRef: { owner: 'f063-workspace-diff', key: coordinate },
    navigationOrigin,
    capabilities: SURFACE_CAPABILITIES,
  };
}
export function resolveCommitChangesTarget(surface: WorkspaceSurfaceDescriptor): CommitChangesTarget | null {
  if (
    surface.type !== 'workspace' ||
    surface.renderer !== 'workspace-destination' ||
    surface.objectRef.kind !== 'workspace-destination' ||
    surface.ownerStateRef.owner !== 'f063-workspace-diff' ||
    surface.resultTargetRef?.owner !== 'f063-workspace-diff'
  )
    return null;
  try {
    const tuple: unknown = JSON.parse(decodeURIComponent(surface.resultTargetRef.key));
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 3 ||
      !tuple.every((value) => typeof value === 'string' && value.length && !/[\x00-\x1f\x7f]/.test(value)) ||
      !/^[0-9a-f]{40}$/.test(tuple[0])
    )
      return null;
    const target = { sha: tuple[0] as string, worktreeId: tuple[1] as string, threadId: tuple[2] as string };
    return surface.ownerStateRef.key === target.worktreeId &&
      surface.objectRef.id === `surface:changes:commit:${key(target)}` &&
      surface.id === `workspace:${surface.objectRef.id}` &&
      key(target) === surface.resultTargetRef.key
      ? target
      : null;
  } catch {
    return null;
  }
}
