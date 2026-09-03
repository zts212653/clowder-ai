import type { WorkbenchLayoutState, WorkspaceSurfaceDescriptor } from './workbench-contract';

export function createInitialWorkbenchState(surfaces: WorkspaceSurfaceDescriptor[] = []): WorkbenchLayoutState {
  return {
    schemaVersion: 2,
    layoutOwner: 'f307',
    surfaces,
    pinnedSurfaceIds: [],
    activeSurfaceId: surfaces[0]?.id ?? null,
    split: null,
    sidecar: null,
    recentlyClosed: [],
    activity: [],
  };
}
