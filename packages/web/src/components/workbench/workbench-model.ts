import type {
  FocusEntitlement,
  WorkbenchAction,
  WorkbenchLayoutState,
  WorkbenchProjection,
  WorkspaceSurfaceDescriptor,
} from './workbench-contract';

export type {
  FocusEntitlement,
  WorkbenchAction,
  WorkbenchLayoutState,
  WorkbenchRenderer,
  WorkspaceSurfaceDescriptor,
} from './workbench-contract';
export { createInitialWorkbenchState } from './workbench-initial-state';
export { migrateF284WorkspaceState, restoreWorkbenchState } from './workbench-restore';

function isUserEntitled(entitlement: FocusEntitlement): boolean {
  return entitlement.kind === 'user';
}

function sameObject(left: WorkspaceSurfaceDescriptor, right: WorkspaceSurfaceDescriptor): boolean {
  return left.objectRef.kind === right.objectRef.kind && left.objectRef.id === right.objectRef.id;
}

function isEntrustedWorkReturnSurface(surface: WorkspaceSurfaceDescriptor): boolean {
  return (
    surface.objectRef.kind === 'workspace-destination' &&
    (surface.objectRef.id === 'mode:needs-me' || surface.objectRef.id === 'mode:product-schedule')
  );
}

function withoutSurface(surfaces: WorkspaceSurfaceDescriptor[], surfaceId: string): WorkspaceSurfaceDescriptor[] {
  return surfaces.filter((surface) => surface.id !== surfaceId);
}

function withoutObject(
  surfaces: WorkspaceSurfaceDescriptor[],
  target: WorkspaceSurfaceDescriptor,
): WorkspaceSurfaceDescriptor[] {
  return surfaces.filter((surface) => surface.id !== target.id && !sameObject(surface, target));
}

function focusSurfaceInSplit(
  state: Pick<WorkbenchLayoutState, 'activeSurfaceId' | 'split'>,
  surfaceId: string,
): WorkbenchLayoutState['split'] {
  if (state.split === null) return null;
  if (state.split.primarySurfaceId === surfaceId || state.split.secondarySurfaceId === surfaceId) return state.split;
  if (state.activeSurfaceId === state.split.secondarySurfaceId) {
    return { ...state.split, secondarySurfaceId: surfaceId };
  }
  return { ...state.split, primarySurfaceId: surfaceId };
}

function recordBackgroundActivity(
  state: WorkbenchLayoutState,
  surface: WorkspaceSurfaceDescriptor,
): WorkbenchLayoutState {
  const kind = surface.type === 'review' ? ('review-ready' as const) : ('surface-ready' as const);
  const activity = {
    id: `${kind}:${surface.id}`,
    kind,
    surfaceId: surface.id,
    surface,
    message: `${surface.title} 已就绪，当前工作保持不动。`,
  };
  return {
    ...state,
    activity: [...state.activity.filter((item) => item.id !== activity.id), activity],
  };
}

function openSurface(
  state: WorkbenchLayoutState,
  action: Extract<WorkbenchAction, { type: 'open-surface' }>,
): WorkbenchLayoutState {
  const existing = state.surfaces.find(
    (surface) => surface.id === action.surface.id || sameObject(surface, action.surface),
  );
  if (!isUserEntitled(action.entitlement)) return recordBackgroundActivity(state, action.surface);
  const surfaces = existing
    ? state.surfaces.map((surface) => (surface.id === existing.id ? action.surface : surface))
    : [...state.surfaces, action.surface];
  const sidecar = state.sidecar && sameObject(state.sidecar, action.surface) ? null : state.sidecar;
  const next = { ...state, surfaces, sidecar };
  const activeSurface = action.surface;
  return {
    ...next,
    activeSurfaceId: activeSurface.id,
    split: focusSurfaceInSplit(state, activeSurface.id),
    recentlyClosed: withoutSurface(next.recentlyClosed, activeSurface.id),
  };
}

function reorderSurface(
  state: WorkbenchLayoutState,
  action: Extract<WorkbenchAction, { type: 'reorder-surface' }>,
): WorkbenchLayoutState {
  const fromIndex = state.surfaces.findIndex((surface) => surface.id === action.surfaceId);
  if (fromIndex < 0 || action.toIndex < 0 || action.toIndex >= state.surfaces.length || fromIndex === action.toIndex) {
    return state;
  }
  const surfaces = [...state.surfaces];
  const [moved] = surfaces.splice(fromIndex, 1);
  if (!moved) return state;
  surfaces.splice(action.toIndex, 0, moved);
  return { ...state, surfaces };
}

function pinSurface(
  state: WorkbenchLayoutState,
  action: Extract<WorkbenchAction, { type: 'pin-surface' }>,
): WorkbenchLayoutState {
  const surface = state.surfaces.find((candidate) => candidate.id === action.surfaceId);
  if (!surface?.capabilities.pin) return state;
  const without = state.pinnedSurfaceIds.filter((surfaceId) => surfaceId !== action.surfaceId);
  return {
    ...state,
    pinnedSurfaceIds: action.pinned ? [...without, action.surfaceId] : without,
  };
}

function splitWith(
  state: WorkbenchLayoutState,
  action: Extract<WorkbenchAction, { type: 'split-with' }>,
): WorkbenchLayoutState {
  const secondary = state.surfaces.find((surface) => surface.id === action.surfaceId);
  if (state.activeSurfaceId === null || state.activeSurfaceId === action.surfaceId || !secondary?.capabilities.split) {
    return state;
  }
  return {
    ...state,
    split: { primarySurfaceId: state.activeSurfaceId, secondarySurfaceId: action.surfaceId },
  };
}

function openSidecar(
  state: WorkbenchLayoutState,
  action: Extract<WorkbenchAction, { type: 'open-sidecar' }>,
): WorkbenchLayoutState {
  if (!action.surface.capabilities.sidecar) return state;
  const existing = state.surfaces.find((surface) => sameObject(surface, action.surface));
  if (existing !== undefined) return state;
  if (state.sidecar && sameObject(state.sidecar, action.surface)) return state;
  return {
    ...state,
    sidecar: action.surface,
    recentlyClosed: withoutObject(state.recentlyClosed, action.surface),
  };
}

function openArtifactWithReturn(
  state: WorkbenchLayoutState,
  action: Extract<WorkbenchAction, { type: 'open-artifact-with-return' }>,
): WorkbenchLayoutState {
  if (
    !isUserEntitled(action.entitlement) ||
    action.artifact.type !== 'artifact' ||
    action.artifact.renderer !== 'artifact-view' ||
    !isEntrustedWorkReturnSurface(action.returnSurface)
  ) {
    return state;
  }
  const hasReturnSurface = state.surfaces.some(
    (surface) => surface.id === action.returnSurface.id || sameObject(surface, action.returnSurface),
  );
  if (!hasReturnSurface) return state;
  const refreshed = state.surfaces.map((surface) =>
    surface.id === action.returnSurface.id || sameObject(surface, action.returnSurface)
      ? action.returnSurface
      : surface,
  );
  const withoutArtifact = withoutObject(refreshed, action.artifact);
  if (action.presentation === 'desktop') {
    return {
      ...state,
      surfaces: [...withoutObject(withoutArtifact, action.returnSurface), action.artifact],
      activeSurfaceId: action.artifact.id,
      split: null,
      sidecar: action.returnSurface,
      pinnedSurfaceIds: state.pinnedSurfaceIds.filter((surfaceId) => surfaceId !== action.returnSurface.id),
      recentlyClosed: withoutObject(withoutObject(state.recentlyClosed, action.returnSurface), action.artifact),
    };
  }
  return {
    ...state,
    surfaces: [...withoutObject(withoutArtifact, action.returnSurface), action.returnSurface, action.artifact],
    activeSurfaceId: action.artifact.id,
    split: null,
    sidecar: null,
    recentlyClosed: withoutObject(state.recentlyClosed, action.artifact),
  };
}

function closeArtifactToReturn(
  state: WorkbenchLayoutState,
  action: Extract<WorkbenchAction, { type: 'close-artifact-to-return' }>,
): WorkbenchLayoutState {
  if (!isUserEntitled(action.entitlement)) return state;
  const artifact = state.surfaces.find(
    (surface) => surface.id === action.artifactSurfaceId && surface.type === 'artifact',
  );
  if (!artifact) return state;
  const openReturn = [...state.surfaces].reverse().find(isEntrustedWorkReturnSurface);
  const sidecarReturn = state.sidecar && isEntrustedWorkReturnSurface(state.sidecar) ? state.sidecar : null;
  const returnSurface = sidecarReturn ?? openReturn;
  if (!returnSurface) return closeSurface(state, { ...action, type: 'close-surface', surfaceId: artifact.id });
  const surfaces = [...withoutObject(withoutSurface(state.surfaces, artifact.id), returnSurface), returnSurface];
  return {
    ...state,
    surfaces,
    activeSurfaceId: returnSurface.id,
    split: null,
    sidecar: sidecarReturn ? null : state.sidecar,
    recentlyClosed: [
      artifact,
      ...withoutObject(withoutSurface(state.recentlyClosed, returnSurface.id), artifact),
    ].slice(0, 5),
  };
}

function promoteSidecar(
  state: WorkbenchLayoutState,
  action: Extract<WorkbenchAction, { type: 'promote-sidecar' }>,
): WorkbenchLayoutState {
  if (state.sidecar === null) return state;
  const promoted = state.sidecar;
  const surfaces = [...state.surfaces, promoted];
  if (action.destination === 'split' && state.activeSurfaceId !== null && promoted.capabilities.split) {
    return {
      ...state,
      surfaces,
      sidecar: null,
      split: { primarySurfaceId: state.activeSurfaceId, secondarySurfaceId: promoted.id },
    };
  }
  return {
    ...state,
    surfaces,
    sidecar: null,
    activeSurfaceId: promoted.id,
    split: focusSurfaceInSplit(state, promoted.id),
  };
}

function closeSurface(
  state: WorkbenchLayoutState,
  action: Extract<WorkbenchAction, { type: 'close-surface' }>,
): WorkbenchLayoutState {
  const closing = state.surfaces.find((surface) => surface.id === action.surfaceId);
  if (!closing) return state;
  const surfaces = withoutSurface(state.surfaces, action.surfaceId);
  const splitContainsSurface =
    state.split?.primarySurfaceId === action.surfaceId || state.split?.secondarySurfaceId === action.surfaceId;
  const splitCounterpart =
    state.split?.primarySurfaceId === action.surfaceId
      ? state.split.secondarySurfaceId
      : state.split?.secondarySurfaceId === action.surfaceId
        ? state.split.primarySurfaceId
        : null;
  const fallbackSurface =
    splitCounterpart !== null && surfaces.some((surface) => surface.id === splitCounterpart)
      ? splitCounterpart
      : (surfaces.at(-1)?.id ?? null);
  return {
    ...state,
    surfaces,
    pinnedSurfaceIds: state.pinnedSurfaceIds.filter((surfaceId) => surfaceId !== action.surfaceId),
    activeSurfaceId: state.activeSurfaceId === action.surfaceId ? fallbackSurface : state.activeSurfaceId,
    split: splitContainsSurface ? null : state.split,
    recentlyClosed: [closing, ...withoutSurface(state.recentlyClosed, action.surfaceId)].slice(0, 5),
  };
}

function restoreSurface(
  state: WorkbenchLayoutState,
  action: Extract<WorkbenchAction, { type: 'restore-surface' }>,
): WorkbenchLayoutState {
  const restoring = state.recentlyClosed.find((surface) => surface.id === action.surfaceId);
  if (!restoring) return state;
  const alreadyHosted =
    state.surfaces.some((surface) => sameObject(surface, restoring)) ||
    (state.sidecar !== null && sameObject(state.sidecar, restoring));
  if (alreadyHosted) {
    return { ...state, recentlyClosed: withoutObject(state.recentlyClosed, restoring) };
  }
  return {
    ...state,
    surfaces: [...state.surfaces, restoring],
    activeSurfaceId: restoring.id,
    split: focusSurfaceInSplit(state, restoring.id),
    recentlyClosed: withoutSurface(state.recentlyClosed, restoring.id),
  };
}

function refreshSurface(state: WorkbenchLayoutState, surface: WorkspaceSurfaceDescriptor): WorkbenchLayoutState {
  const inTabs = state.surfaces.some((candidate) => candidate.id === surface.id);
  const inSidecar = state.sidecar?.id === surface.id;
  if (!inTabs && !inSidecar) return state;
  return {
    ...state,
    surfaces: state.surfaces.map((candidate) => (candidate.id === surface.id ? surface : candidate)),
    sidecar: inSidecar ? surface : state.sidecar,
  };
}

export function reduceWorkbench(state: WorkbenchLayoutState, action: WorkbenchAction): WorkbenchLayoutState {
  if (action.type === 'dismiss-activity') {
    return { ...state, activity: state.activity.filter((item) => item.id !== action.activityId) };
  }
  if (action.type === 'open-surface') return openSurface(state, action);
  if (action.type === 'refresh-surface') return refreshSurface(state, action.surface);
  if (action.type === 'open-artifact-with-return') return openArtifactWithReturn(state, action);
  if (action.type === 'close-artifact-to-return') return closeArtifactToReturn(state, action);
  if (!isUserEntitled(action.entitlement)) return state;
  if (action.type === 'activate-surface') {
    return state.surfaces.some((surface) => surface.id === action.surfaceId)
      ? {
          ...state,
          activeSurfaceId: action.surfaceId,
          split: focusSurfaceInSplit(state, action.surfaceId),
        }
      : state;
  }
  if (action.type === 'reorder-surface') return reorderSurface(state, action);
  if (action.type === 'pin-surface') return pinSurface(state, action);
  if (action.type === 'split-with') return splitWith(state, action);
  if (action.type === 'open-sidecar') return openSidecar(state, action);
  if (action.type === 'promote-sidecar') return promoteSidecar(state, action);
  if (action.type === 'close-sidecar') {
    if (state.sidecar === null) return state;
    return {
      ...state,
      sidecar: null,
      recentlyClosed: [state.sidecar, ...withoutSurface(state.recentlyClosed, state.sidecar.id)].slice(0, 5),
    };
  }
  if (action.type === 'close-surface') return closeSurface(state, action);
  return restoreSurface(state, action);
}

export function projectWorkbench(state: WorkbenchLayoutState, width: number): WorkbenchProjection {
  if (width >= 768 && state.split !== null) {
    return {
      kind: 'split',
      visibleSurfaceIds: [state.split.primarySurfaceId, state.split.secondarySurfaceId],
      sidecarSurfaceId: state.sidecar?.id ?? null,
    };
  }
  return {
    kind: 'stack',
    visibleSurfaceIds: state.activeSurfaceId === null ? [] : [state.activeSurfaceId],
    sidecarSurfaceId: state.sidecar?.id ?? null,
  };
}
