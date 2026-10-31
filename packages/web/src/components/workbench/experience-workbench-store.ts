import { create } from 'zustand';
import { resolveShellCopy } from '@/components/shell/shell-copy';
import { readShellLanguage } from '@/components/shell/shell-language';
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
import {
  createEntrustedReturnFromRef,
  isRealSurfaceOwnerAvailable,
  resolveEvolutionProgramId,
  resolveWorkspaceDestinationTarget,
} from './real-surface-adapters';
import { workspaceChromeCopy } from './workspace-chrome.shell-copy';
import type { MainAreaAttentionPresentation } from './workspace-work-host-projection';

interface ExperienceWorkbenchStore {
  layout: WorkbenchLayoutState;
  hydrated: boolean;
  /** Transient host projection. It is intentionally excluded from persisted layout truth. */
  mainAreaAttentionSurfaceId: string | null;
  mainAreaAttentionPresentation: MainAreaAttentionPresentation;
  /** Transient chrome projection. The owner surface and persisted working set stay unchanged. */
  focusSurfaceId: string | null;
  /** KD-25 transient geometry/return session; deliberately outside persisted Workbench topology. */
  artifactWorkPresentation: ArtifactWorkPresentationState;
  dispatch: (action: WorkbenchAction) => void;
  dispatchArtifactWorkPresentation: (command: ArtifactWorkPresentationCommand) => ArtifactWorkPresentationEffect;
  hydrate: (f284WorkspaceState?: F284WorkspaceSnapshot) => void;
  enterMainAreaAttention: (surfaceId: string, presentation?: MainAreaAttentionPresentation) => void;
  enterMainAreaFullWindow: (surfaceId: string) => void;
  returnFromMainAreaFullWindow: () => void;
  setMainAreaAttentionChatBasis: (basis: number) => void;
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

function attentionAfterAction(
  current: ExperienceWorkbenchStore,
  layout: WorkbenchLayoutState,
  action: WorkbenchAction,
): string | null {
  const sourceId = current.mainAreaAttentionSurfaceId;
  if (current.mainAreaAttentionPresentation.kind === 'chat-workspace' && sourceId !== null) {
    if (
      action.type === 'open-artifact-with-return' &&
      current.layout.activeSurfaceId === sourceId &&
      action.returnSurface.id === sourceId &&
      layout.sidecar?.id === sourceId &&
      layout.activeSurfaceId === action.artifact.id
    ) {
      return retainMainAreaAttention(layout, layout.activeSurfaceId);
    }
    if (
      action.type === 'close-artifact-to-return' &&
      action.artifactSurfaceId === sourceId &&
      current.layout.activeSurfaceId === sourceId
    ) {
      const source = current.layout.surfaces.find((surface) => surface.id === sourceId);
      const bound = createEntrustedReturnFromRef(source?.returnTargetRef);
      if (bound?.id === layout.activeSurfaceId) return retainMainAreaAttention(layout, layout.activeSurfaceId);
    }
  }
  if (action.type === 'resolve-content-surface') {
    return retainMainAreaAttention(layout, sourceId === action.sourceSurfaceId ? layout.activeSurfaceId : sourceId);
  }
  return detachedAnySurface(current.layout, layout) ? null : retainMainAreaAttention(layout, sourceId);
}

function hostedSurfaceIds(layout: WorkbenchLayoutState): Set<string> {
  return new Set([...layout.surfaces.map((surface) => surface.id), ...(layout.sidecar ? [layout.sidecar.id] : [])]);
}

function detachedAnySurface(before: WorkbenchLayoutState, after: WorkbenchLayoutState): boolean {
  const afterIds = hostedSurfaceIds(after);
  return [...hostedSurfaceIds(before)].some((surfaceId) => !afterIds.has(surfaceId));
}

function persistLayout(layout: WorkbenchLayoutState): boolean {
  if (typeof window === 'undefined') return true;
  try {
    writeWorkbenchState(window.localStorage, layout);
    return true;
  } catch {
    return false;
  }
}

function persistAcceptedLayout(layout: WorkbenchLayoutState): WorkbenchLayoutState {
  const warningId = 'restore-warning:storage';
  const candidate = layout.activity.some((item) => item.id === warningId)
    ? { ...layout, activity: layout.activity.filter((item) => item.id !== warningId) }
    : layout;
  if (persistLayout(candidate)) return candidate;
  return {
    ...candidate,
    activity: [
      ...candidate.activity,
      {
        id: warningId,
        kind: 'restore-warning',
        message: resolveShellCopy(workspaceChromeCopy, readShellLanguage()).saveFailed,
      },
    ],
  };
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
  mainAreaAttentionPresentation: { kind: 'overlay' },
  focusSurfaceId: null,
  artifactWorkPresentation: DEFAULT_ARTIFACT_WORK_PRESENTATION,
  dispatch: (action) => {
    set((current) => {
      const layout = persistAcceptedLayout(reduceWorkbench(current.layout, action));
      // Transient focus/attention belongs to the active node; canonical resolution may retain
      // an existing identity or reject the request, so the reducer result is authoritative.
      const remappedFocusSurfaceId =
        action.type === 'resolve-content-surface' && current.focusSurfaceId === action.sourceSurfaceId
          ? layout.activeSurfaceId
          : current.focusSurfaceId;
      const attentionSurfaceId = attentionAfterAction(current, layout, action);
      const session = current.artifactWorkPresentation.session;
      // Native alias/publication resolution replaces the active descriptor, not its explicit work-mode intent.
      const resolvedWorkSession =
        session?.workMode &&
        action.type === 'resolve-content-surface' &&
        session.surfaceId === action.sourceSurfaceId &&
        layout.activeSurfaceId
          ? { ...current.artifactWorkPresentation, session: { ...session, surfaceId: layout.activeSurfaceId } }
          : current.artifactWorkPresentation;
      return {
        layout,
        artifactWorkPresentation: resolvedWorkSession,
        mainAreaAttentionSurfaceId: attentionSurfaceId,
        mainAreaAttentionPresentation:
          attentionSurfaceId === null ? { kind: 'overlay' } : current.mainAreaAttentionPresentation,
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
      mainAreaAttentionPresentation: { kind: 'overlay' },
      focusSurfaceId: null,
      artifactWorkPresentation: createArtifactWorkPresentationState(loadArtifactWorkChatBasis()),
    }));
  },
  enterMainAreaAttention: (surfaceId, presentation = { kind: 'overlay' }) => {
    set((current) => {
      const surface = current.layout.surfaces.find((surface) => surface.id === surfaceId);
      const target = surface ? resolveWorkspaceDestinationTarget(surface) : null;
      const admitted =
        current.layout.activeSurfaceId === surfaceId &&
        surface !== undefined &&
        (presentation.kind === 'overlay' ||
          (presentation.kind === 'chat-workspace' &&
            ((target?.destinationRef === 'mode:product-schedule' && target.threadId === presentation.threadId) ||
              resolveEvolutionProgramId(surface) !== null)));
      return {
        mainAreaAttentionSurfaceId: admitted ? surfaceId : null,
        mainAreaAttentionPresentation: admitted ? presentation : { kind: 'overlay' },
      };
    });
  },
  enterMainAreaFullWindow: (surfaceId) => {
    set((current) => {
      if (
        current.mainAreaAttentionSurfaceId === surfaceId &&
        current.mainAreaAttentionPresentation.kind === 'chat-workspace'
      ) {
        return {
          mainAreaAttentionPresentation: {
            ...current.mainAreaAttentionPresentation,
            mode: 'full-window',
          },
        };
      }
      const admitted =
        current.layout.activeSurfaceId === surfaceId &&
        current.layout.surfaces.some((surface) => surface.id === surfaceId);
      return {
        mainAreaAttentionSurfaceId: admitted ? surfaceId : null,
        mainAreaAttentionPresentation: { kind: 'overlay' },
      };
    });
  },
  returnFromMainAreaFullWindow: () => {
    set((current) => {
      if (
        current.mainAreaAttentionSurfaceId !== null &&
        current.mainAreaAttentionPresentation.kind === 'chat-workspace' &&
        current.mainAreaAttentionPresentation.mode === 'full-window'
      ) {
        return {
          mainAreaAttentionPresentation: {
            kind: 'chat-workspace',
            threadId: current.mainAreaAttentionPresentation.threadId,
            chatBasis: current.mainAreaAttentionPresentation.chatBasis,
          },
        };
      }
      return { mainAreaAttentionSurfaceId: null, mainAreaAttentionPresentation: { kind: 'overlay' } };
    });
  },
  setMainAreaAttentionChatBasis: (basis) => {
    if (!Number.isFinite(basis)) return;
    set((current) =>
      current.mainAreaAttentionPresentation.kind === 'chat-workspace'
        ? {
            mainAreaAttentionPresentation: {
              ...current.mainAreaAttentionPresentation,
              chatBasis: Math.min(80, Math.max(20, basis)),
            },
          }
        : {},
    );
  },
  exitMainAreaAttention: () =>
    set({ mainAreaAttentionSurfaceId: null, mainAreaAttentionPresentation: { kind: 'overlay' } }),
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
