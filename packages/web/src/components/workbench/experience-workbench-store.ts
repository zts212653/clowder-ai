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
  dispatch: (action: WorkbenchAction) => void;
  hydrate: (f284WorkspaceState?: F284WorkspaceSnapshot) => void;
}

const DEFAULT_LAYOUT = createInitialWorkbenchState();

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
  dispatch: (action) => {
    set((current) => {
      const layout = reduceWorkbench(current.layout, action);
      persistLayout(layout);
      return { layout };
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
    set({ layout, hydrated: true });
  },
}));
