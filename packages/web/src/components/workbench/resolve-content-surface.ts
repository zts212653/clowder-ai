import { resolveArtifactReviewTarget } from './artifact-review-surface';
import { resolveMessagePublicationSource } from './message-publication-surface';
import { resolvePublicationTarget } from './publication-surface';
import { resolveFileTarget } from './real-surface-adapters';
import type { WorkbenchLayoutState, WorkspaceSurfaceDescriptor } from './workbench-contract';

/** Resolution changes the content coordinate; its original message/list return remains owned by the source. */
export function inheritContentSurfaceOrigin(
  source: WorkspaceSurfaceDescriptor,
  target: WorkspaceSurfaceDescriptor,
): WorkspaceSurfaceDescriptor {
  const messagePublicationSource =
    target.messagePublicationSource ?? resolveMessagePublicationSource(source) ?? source.messagePublicationSource;
  return {
    ...target,
    ...(messagePublicationSource ? { messagePublicationSource } : {}),
    ...(source.navigationOrigin ? { navigationOrigin: source.navigationOrigin } : {}),
    ...(source.returnTargetRef ? { returnTargetRef: source.returnTargetRef } : {}),
    ...(!target.artifactFileSource && source.artifactFileSource
      ? { artifactFileSource: source.artifactFileSource }
      : {}),
  };
}

export function resolveContentSurfaceIdentity(
  state: WorkbenchLayoutState,
  sourceId: string,
  target: WorkspaceSurfaceDescriptor,
): WorkbenchLayoutState {
  const source =
    state.surfaces.find((item) => item.id === sourceId) ?? (state.sidecar?.id === sourceId ? state.sidecar : null);
  if (
    !source ||
    (!resolvePublicationTarget(target) && !resolveArtifactReviewTarget(target) && !resolveFileTarget(target))
  )
    return state;
  const fileTarget = resolveFileTarget(target);
  const matchesTarget = (item: WorkspaceSurfaceDescriptor) => {
    if (item.id === target.id) return true;
    if (!fileTarget) return false;
    const file = resolveFileTarget(item);
    return !!file && file.worktreeId === fileTarget.worktreeId && file.path === fileTarget.path;
  };
  const retained =
    state.surfaces.find((item) => item.id !== sourceId && matchesTarget(item)) ??
    (state.sidecar && state.sidecar.id !== sourceId && matchesTarget(state.sidecar) ? state.sidecar : null);
  const resolvedId = retained?.id ?? target.id;
  const resolved =
    retained && state.activeSurfaceId !== sourceId
      ? retained
      : inheritContentSurfaceOrigin(source, {
          ...target,
          ...(retained && fileTarget ? { id: retained.id, objectRef: retained.objectRef } : {}),
        });
  const alreadyOpen = state.surfaces.some((item) => item.id === resolvedId && item.id !== sourceId);
  const surfaces = state.surfaces.flatMap((item) =>
    item.id === sourceId ? (alreadyOpen ? [] : [resolved]) : item.id === resolvedId ? [resolved] : [item],
  );
  const sidecar =
    state.sidecar?.id === sourceId
      ? surfaces.some((item) => item.id === resolvedId)
        ? null
        : resolved
      : state.sidecar?.id === resolvedId && surfaces.some((item) => item.id === resolvedId)
        ? null
        : state.sidecar;
  const replace = (id: string) => (id === sourceId ? resolvedId : id);
  const split = state.split
    ? {
        primarySurfaceId: replace(state.split.primarySurfaceId),
        secondarySurfaceId: replace(state.split.secondarySurfaceId),
      }
    : null;
  return {
    ...state,
    surfaces,
    sidecar,
    previewSurfaceId: state.previewSurfaceId === sourceId ? (retained ? null : resolvedId) : state.previewSurfaceId,
    activeSurfaceId: state.activeSurfaceId ? replace(state.activeSurfaceId) : null,
    pinnedSurfaceIds: [...new Set(state.pinnedSurfaceIds.map(replace))].filter((id) =>
      surfaces.some((item) => item.id === id),
    ),
    split: split?.primarySurfaceId === split?.secondarySurfaceId ? null : split,
    recentlyClosed: state.recentlyClosed.filter(
      (item) => item.id !== sourceId && item.id !== resolvedId && item.id !== target.id,
    ),
    activity: state.activity.map((item) =>
      item.surfaceId === sourceId ? { ...item, surfaceId: resolvedId, surface: resolved } : item,
    ),
  };
}
