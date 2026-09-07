import { create } from 'zustand';
import type {
  F284WorkspaceSnapshot,
  WorkbenchAction,
  WorkbenchLayoutState,
} from '@/components/workbench/workbench-contract';
import { createInitialWorkbenchState, reduceWorkbench } from '@/components/workbench/workbench-model';
import { loadWorkbenchState, writeWorkbenchState } from '@/components/workbench/workbench-persistence';
import { isRealSurfaceOwnerAvailable } from './real-surface-adapters';

interface ExperienceWorkbenchStore {
  layout: WorkbenchLayoutState;
  hydrated: boolean;
  /** Transient host projection. It is intentionally excluded from persisted layout truth. */
  mainAreaAttentionSurfaceId: string | null;
  dispatch: (action: WorkbenchAction) => void;
  hydrate: (f284WorkspaceState?: F284WorkspaceSnapshot) => void;
  enterMainAreaAttention: (surfaceId: string) => void;
  exitMainAreaAttention: () => void;
}

const DEFAULT_LAYOUT = createInitialWorkbenchState();

function retainMainAreaAttention(layout: WorkbenchLayoutState, surfaceId: string | null): string | null {
  if (surfaceId === null || layout.activeSurfaceId !== surfaceId) return null;
  const surface = layout.surfaces.find((candidate) => candidate.id === surfaceId);
  return surface?.capabilities.mainAreaAttention === true ? surfaceId : null;
}

function hostedSurfaceIds(layout: WorkbenchLayoutState): Set<string> {
  return new Set([...layout.surfaces.map((surface) => surface.id), ...(layout.sidecar ? [layout.sidecar.id] : [])]);
}

function detachedAnySurface(before: WorkbenchLayoutState, after: WorkbenchLayoutState): boolean {
  const afterIds = hostedSurfaceIds(after);
  return [...hostedSurfaceIds(before)].some((surfaceId) => !afterIds.has(surfaceId));
}

function persistLayout(layout: WorkbenchLayoutState): void {
  if (typeof window === 'undefined') return;
  try {
    writeWorkbenchState(window.localStorage, layout);
  } catch {
    // The controlled candidate remains usable when browser persistence is unavailable.
  }
}

export const useF307ExperienceWorkbenchStore = create<ExperienceWorkbenchStore>((set) => ({
  layout: DEFAULT_LAYOUT,
  hydrated: false,
  mainAreaAttentionSurfaceId: null,
  dispatch: (action) => {
    set((current) => {
      const layout = reduceWorkbench(current.layout, action);
      persistLayout(layout);
      return {
        layout,
        mainAreaAttentionSurfaceId: detachedAnySurface(current.layout, layout)
          ? null
          : retainMainAreaAttention(layout, current.mainAreaAttentionSurfaceId),
      };
    });
  },
  hydrate: (f284WorkspaceState) => {
    if (typeof window === 'undefined') return;
    let layout = DEFAULT_LAYOUT;
    try {
      layout = loadWorkbenchState({
        storage: window.localStorage,
        f284WorkspaceState,
        defaultLayout: DEFAULT_LAYOUT,
        isOwnerRefAvailable: isRealSurfaceOwnerAvailable,
      }).layout;
    } catch {
      // Storage access itself can fail in privacy-constrained browsers; keep the safe default.
    }
    set({ layout, hydrated: true, mainAreaAttentionSurfaceId: null });
  },
  enterMainAreaAttention: (surfaceId) => {
    set((current) => ({
      mainAreaAttentionSurfaceId:
        current.layout.activeSurfaceId === surfaceId &&
        current.layout.surfaces.some(
          (surface) => surface.id === surfaceId && surface.capabilities.mainAreaAttention === true,
        )
          ? surfaceId
          : null,
    }));
  },
  exitMainAreaAttention: () => set({ mainAreaAttentionSurfaceId: null }),
}));
