import { resolveArtifactReviewTarget } from './artifact-review-surface';
import { resolveMessagePublicationSource } from './message-publication-surface';
import { resolvePublicationTarget } from './publication-surface';
import { resolveFileTarget } from './real-surface-adapters';
import type { WorkbenchLayoutState, WorkspaceSurfaceDescriptor } from './workbench-contract';

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
  const retained =
    state.surfaces.find((item) => item.id === target.id && item.id !== sourceId) ??
    (state.sidecar?.id === target.id && state.sidecar.id !== sourceId ? state.sidecar : null);
  const messagePublicationSource =
    target.messagePublicationSource ?? resolveMessagePublicationSource(source) ?? source.messagePublicationSource;
  const resolved =
    retained && state.activeSurfaceId !== sourceId
      ? retained
      : {
          ...target,
          ...(messagePublicationSource ? { messagePublicationSource } : {}),
          ...(source.navigationOrigin ? { navigationOrigin: source.navigationOrigin } : {}),
          ...(source.returnTargetRef ? { returnTargetRef: source.returnTargetRef } : {}),
          ...(!target.artifactFileSource && source.artifactFileSource
            ? { artifactFileSource: source.artifactFileSource }
            : {}),
        };
  const alreadyOpen = state.surfaces.some((item) => item.id === target.id && item.id !== sourceId);
  const surfaces = state.surfaces.flatMap((item) =>
    item.id === sourceId ? (alreadyOpen ? [] : [resolved]) : item.id === target.id ? [resolved] : [item],
  );
  const sidecar =
    state.sidecar?.id === sourceId
      ? surfaces.some((item) => item.id === target.id)
        ? null
        : resolved
      : state.sidecar?.id === target.id && surfaces.some((item) => item.id === target.id)
        ? null
        : state.sidecar;
  const replace = (id: string) => (id === sourceId ? target.id : id);
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
    activeSurfaceId: state.activeSurfaceId ? replace(state.activeSurfaceId) : null,
    pinnedSurfaceIds: [...new Set(state.pinnedSurfaceIds.map(replace))].filter((id) =>
      surfaces.some((item) => item.id === id),
    ),
    split: split?.primarySurfaceId === split?.secondarySurfaceId ? null : split,
    recentlyClosed: state.recentlyClosed.filter((item) => item.id !== sourceId && item.id !== target.id),
    activity: state.activity.map((item) =>
      item.surfaceId === sourceId ? { ...item, surfaceId: target.id, surface: resolved } : item,
    ),
  };
}
