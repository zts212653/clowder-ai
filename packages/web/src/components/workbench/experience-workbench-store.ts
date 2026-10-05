import { create } from 'zustand';
import type {
  F284WorkspaceSnapshot,
  WorkbenchAction,
  WorkbenchLayoutState,
} from '@/components/workbench/workbench-contract';
import { createInitialWorkbenchState, reduceWorkbench } from '@/components/workbench/workbench-model';
import { loadWorkbenchState, writeWorkbenchState } from '@/components/workbench/workbench-persistence';
import {
  type ArtifactWorkPresentationCommand,
  type ArtifactWorkPresentationEffect,
  type ArtifactWorkPresentationState,
  createArtifactWorkPresentationState,
  DEFAULT_ARTIFACT_WORK_CHAT_BASIS,
  reduceArtifactWorkPresentation,
} from './artifact-work-presentation';
import { isRealSurfaceOwnerAvailable } from './real-surface-adapters';

interface ExperienceWorkbenchStore {
  layout: WorkbenchLayoutState;
  hydrated: boolean;
  /** Transient host projection. It is intentionally excluded from persisted layout truth. */
  mainAreaAttentionSurfaceId: string | null;
  /** Transient chrome projection. The owner surface and persisted working set stay unchanged. */
  focusSurfaceId: string | null;
  /** KD-25 transient geometry/return session; deliberately outside persisted Workbench topology. */
  artifactWorkPresentation: ArtifactWorkPresentationState;
  dispatch: (action: WorkbenchAction) => void;
  dispatchArtifactWorkPresentation: (command: ArtifactWorkPresentationCommand) => ArtifactWorkPresentationEffect;
  hydrate: (f284WorkspaceState?: F284WorkspaceSnapshot) => void;
  enterMainAreaAttention: (surfaceId: string) => void;
  exitMainAreaAttention: () => void;
  enterFocusMode: (surfaceId: string) => void;
  exitFocusMode: () => void;
}

const DEFAULT_LAYOUT = createInitialWorkbenchState();
const DEFAULT_ARTIFACT_WORK_PRESENTATION = createArtifactWorkPresentationState();
export const ARTIFACT_WORK_CHAT_BASIS_STORAGE_KEY = 'cat-cafe:artifactWorkChatBasis';

function retainMainAreaAttention(layout: WorkbenchLayoutState, surfaceId: string | null): string | null {
  if (surfaceId === null || layout.activeSurfaceId !== surfaceId) return null;
  return layout.surfaces.some((surface) => surface.id === surfaceId) ? surfaceId : null;
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

function persistArtifactWorkChatBasis(basis: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ARTIFACT_WORK_CHAT_BASIS_STORAGE_KEY, String(basis));
  } catch {
    // Geometry remains usable when browser persistence is unavailable.
  }
}

function loadArtifactWorkChatBasis(): number {
  if (typeof window === 'undefined') return DEFAULT_ARTIFACT_WORK_CHAT_BASIS;
  try {
    const stored = window.localStorage.getItem(ARTIFACT_WORK_CHAT_BASIS_STORAGE_KEY);
    if (stored === null) return DEFAULT_ARTIFACT_WORK_CHAT_BASIS;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? parsed : DEFAULT_ARTIFACT_WORK_CHAT_BASIS;
  } catch {
    return DEFAULT_ARTIFACT_WORK_CHAT_BASIS;
  }
}

export const useF307ExperienceWorkbenchStore = create<ExperienceWorkbenchStore>((set) => ({
  layout: DEFAULT_LAYOUT,
  hydrated: false,
  mainAreaAttentionSurfaceId: null,
  focusSurfaceId: null,
  artifactWorkPresentation: DEFAULT_ARTIFACT_WORK_PRESENTATION,
  dispatch: (action) => {
    set((current) => {
      const layout = reduceWorkbench(current.layout, action);
      persistLayout(layout);
      const remappedFocusSurfaceId =
        action.type === 'resolve-content-surface' && current.focusSurfaceId === action.sourceSurfaceId
          ? action.surface.id
          : current.focusSurfaceId;
      return {
        layout,
        mainAreaAttentionSurfaceId:
          action.type === 'resolve-content-surface'
            ? retainMainAreaAttention(
                layout,
                current.mainAreaAttentionSurfaceId === action.sourceSurfaceId
                  ? action.surface.id
                  : current.mainAreaAttentionSurfaceId,
              )
            : detachedAnySurface(current.layout, layout)
              ? null
              : retainMainAreaAttention(layout, current.mainAreaAttentionSurfaceId),
        focusSurfaceId: retainMainAreaAttention(layout, remappedFocusSurfaceId),
      };
    });
  },
  dispatchArtifactWorkPresentation: (command) => {
    let effect: ArtifactWorkPresentationEffect = { kind: 'none' };
    set((current) => {
      const transition = reduceArtifactWorkPresentation(current.artifactWorkPresentation, command);
      effect = transition.effect;
      if (transition.state.desktopWorkChatBasis !== current.artifactWorkPresentation.desktopWorkChatBasis) {
        persistArtifactWorkChatBasis(transition.state.desktopWorkChatBasis);
      }
      return { artifactWorkPresentation: transition.state };
    });
    return effect;
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
    set(() => ({
      layout,
      hydrated: true,
      mainAreaAttentionSurfaceId: null,
      focusSurfaceId: null,
      artifactWorkPresentation: createArtifactWorkPresentationState(loadArtifactWorkChatBasis()),
    }));
  },
  enterMainAreaAttention: (surfaceId) => {
    set((current) => ({
      mainAreaAttentionSurfaceId:
        current.layout.activeSurfaceId === surfaceId &&
        current.layout.surfaces.some((surface) => surface.id === surfaceId)
          ? surfaceId
          : null,
    }));
  },
  exitMainAreaAttention: () => set({ mainAreaAttentionSurfaceId: null }),
  enterFocusMode: (surfaceId) => {
    set((current) => ({
      focusSurfaceId:
        current.layout.activeSurfaceId === surfaceId &&
        current.layout.surfaces.some((surface) => surface.id === surfaceId)
          ? surfaceId
          : null,
    }));
  },
  exitFocusMode: () => set({ focusSurfaceId: null }),
}));
