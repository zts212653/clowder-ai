import { resolveFileTarget } from './real-surface-adapters';
import type { WorkbenchLayoutState, WorkspaceSurfaceDescriptor } from './workbench-contract';

const sameObject = (a: WorkspaceSurfaceDescriptor, b: WorkspaceSurfaceDescriptor) => {
  if (a.objectRef.kind === 'file' && b.objectRef.kind === 'file') {
    const first = resolveFileTarget(a);
    const second = resolveFileTarget(b);
    return !!first && !!second && first.worktreeId === second.worktreeId && first.path === second.path;
  }
  return a.objectRef.kind === b.objectRef.kind && a.objectRef.id === b.objectRef.id;
};

/** Invalid or pinned references never become an inferred preview slot. */
export function retainPreviewSlot(state: WorkbenchLayoutState): WorkbenchLayoutState {
  const id = state.previewSurfaceId;
  const retained = id && !state.pinnedSurfaceIds.includes(id) && state.surfaces.some((s) => s.id === id) ? id : null;
  return retained === id ? state : { ...state, previewSurfaceId: retained };
}

/** Replace only the declared slot; each new descriptor carries its own source and return coordinates. */
export function openPreviewSurface(
  state: WorkbenchLayoutState,
  surface: WorkspaceSurfaceDescriptor,
  focusInSplit: (
    state: Pick<WorkbenchLayoutState, 'activeSurfaceId' | 'split'>,
    surfaceId: string,
  ) => WorkbenchLayoutState['split'],
): WorkbenchLayoutState {
  const current = state.surfaces.find((s) => s.id === state.previewSurfaceId);
  const existing = state.surfaces.find((s) => s.id === surface.id || sameObject(s, surface));
  if (existing && existing.id !== current?.id) {
    // A permanent tab is already this object. Opening it does not demote it into a preview.
    return {
      ...state,
      surfaces: state.surfaces.map((item) =>
        item.id === existing.id ? { ...surface, id: existing.id, objectRef: existing.objectRef } : item,
      ),
      activeSurfaceId: existing.id,
      split: focusInSplit(state, existing.id),
    };
  }
  const surfaces = current
    ? state.surfaces.map((s) => (s.id === current.id ? surface : s))
    : [...state.surfaces, surface];
  const replace = (id: string) => (current && id === current.id ? surface.id : id);
  const split = state.split
    ? {
        primarySurfaceId: replace(state.split.primarySurfaceId),
        secondarySurfaceId: replace(state.split.secondarySurfaceId),
      }
    : null;
  return {
    ...state,
    surfaces,
    previewSurfaceId: surface.id,
    activeSurfaceId: surface.id,
    split: focusInSplit({ ...state, split }, surface.id),
    sidecar: state.sidecar && sameObject(state.sidecar, surface) ? null : state.sidecar,
    recentlyClosed: [
      ...(current && !sameObject(current, surface) ? [current] : []),
      ...state.recentlyClosed.filter((s) => s.id !== surface.id && !sameObject(s, surface) && s.id !== current?.id),
    ].slice(0, 5),
  };
}
