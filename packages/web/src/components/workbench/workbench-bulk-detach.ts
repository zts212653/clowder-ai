import type { WorkbenchLayoutState } from './workbench-contract';

/** Detach a working set once; single-close return edges do not participate in bulk closure. */
export function detachUnpinnedSurfaces(state: WorkbenchLayoutState, preserveSurfaceId?: string): WorkbenchLayoutState {
  if (preserveSurfaceId && !state.surfaces.some((surface) => surface.id === preserveSurfaceId)) return state;
  const retained = state.surfaces.filter(
    (surface) => surface.id === preserveSurfaceId || state.pinnedSurfaceIds.includes(surface.id),
  );
  if (retained.length === state.surfaces.length) return state;
  const ids = new Set(retained.map((surface) => surface.id));
  const detached = state.surfaces.filter((surface) => !ids.has(surface.id));
  const recent = state.recentlyClosed.filter(
    (item) =>
      !detached.some(
        (surface) =>
          surface.id === item.id ||
          (surface.objectRef.kind === item.objectRef.kind && surface.objectRef.id === item.objectRef.id),
      ),
  );
  return {
    ...state,
    surfaces: retained,
    activeSurfaceId:
      preserveSurfaceId ??
      (state.activeSurfaceId && ids.has(state.activeSurfaceId) ? state.activeSurfaceId : (retained.at(-1)?.id ?? null)),
    split:
      state.split && ids.has(state.split.primarySurfaceId) && ids.has(state.split.secondarySurfaceId)
        ? state.split
        : null,
    recentlyClosed: [...detached, ...recent].slice(0, 5),
  };
}
