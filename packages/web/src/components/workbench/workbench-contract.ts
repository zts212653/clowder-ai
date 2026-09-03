export type WorkbenchSurfaceType =
  | 'agent-run'
  | 'artifact'
  | 'browser'
  | 'code'
  | 'evolution-program'
  | 'file'
  | 'review'
  | 'terminal'
  | 'workspace';

export type WorkbenchRenderer =
  | 'agent-run'
  | 'artifact-view'
  | 'browser-preview'
  | 'code-editor'
  | 'evolution-program'
  | 'file-preview'
  | 'review-summary'
  | 'terminal-session'
  | 'workspace-destination';

export type WorkbenchObjectKind =
  | 'agent-run'
  | 'artifact'
  | 'evolution-program'
  | 'file'
  | 'preview-session'
  | 'review'
  | 'terminal-session'
  | 'workspace-destination';

export interface WorkspaceSurfaceDescriptor {
  id: string;
  type: WorkbenchSurfaceType;
  renderer: WorkbenchRenderer;
  title: string;
  context: string;
  objectRef: {
    kind: WorkbenchObjectKind;
    id: string;
  };
  ownerStateRef: {
    owner: string;
    key: string;
  };
  /** Optional in schema v2 for backward compatibility; real Phase C adapters always emit it. */
  resultTargetRef?: {
    owner: string;
    key: string;
  };
  capabilities: {
    split: boolean;
    sidecar: boolean;
    pin: boolean;
    closePolicy: 'detach-host';
    restorePolicy: 'descriptor';
  };
}

export interface WorkbenchActivity {
  id: string;
  kind: 'review-ready' | 'restore-warning' | 'surface-ready';
  surfaceId?: string;
  /** A validated descriptor lets the user explicitly reveal a background arrival later. */
  surface?: WorkspaceSurfaceDescriptor;
  message: string;
}

export interface WorkbenchLayoutState {
  schemaVersion: 2;
  layoutOwner: 'f307';
  surfaces: WorkspaceSurfaceDescriptor[];
  pinnedSurfaceIds: string[];
  activeSurfaceId: string | null;
  split: {
    primarySurfaceId: string;
    secondarySurfaceId: string;
  } | null;
  sidecar: WorkspaceSurfaceDescriptor | null;
  recentlyClosed: WorkspaceSurfaceDescriptor[];
  activity: WorkbenchActivity[];
}

export interface FocusEntitlement {
  kind: 'user' | 'background';
  reason:
    | 'close-button'
    | 'explicit-split'
    | 'open-from-chat'
    | 'owner-background'
    | 'recently-closed'
    | 'review-ready'
    | 'sidecar-action'
    | 'surface-tab'
    | 'workspace-home-selection';
}

interface EntitledAction {
  entitlement: FocusEntitlement;
}

export type WorkbenchAction =
  | ({ type: 'open-surface'; surface: WorkspaceSurfaceDescriptor } & EntitledAction)
  | { type: 'refresh-surface'; surface: WorkspaceSurfaceDescriptor }
  | ({ type: 'activate-surface'; surfaceId: string } & EntitledAction)
  | ({ type: 'reorder-surface'; surfaceId: string; toIndex: number } & EntitledAction)
  | ({ type: 'pin-surface'; surfaceId: string; pinned: boolean } & EntitledAction)
  | ({ type: 'split-with'; surfaceId: string } & EntitledAction)
  | ({ type: 'open-sidecar'; surface: WorkspaceSurfaceDescriptor } & EntitledAction)
  | ({
      type: 'open-artifact-with-return';
      artifact: WorkspaceSurfaceDescriptor;
      returnSurface: WorkspaceSurfaceDescriptor;
      presentation: 'desktop' | 'mobile';
    } & EntitledAction)
  | ({ type: 'close-artifact-to-return'; artifactSurfaceId: string } & EntitledAction)
  | ({ type: 'close-sidecar' } & EntitledAction)
  | ({ type: 'promote-sidecar'; destination: 'tab' | 'split' } & EntitledAction)
  | ({ type: 'close-surface'; surfaceId: string } & EntitledAction)
  | ({ type: 'restore-surface'; surfaceId: string } & EntitledAction)
  | { type: 'dismiss-activity'; activityId: string };

export interface WorkbenchProjection {
  kind: 'split' | 'stack';
  visibleSurfaceIds: string[];
  sidecarSurfaceId: string | null;
}

export interface RestoreWorkbenchOptions {
  isOwnerRefAvailable?: (surface: WorkspaceSurfaceDescriptor) => boolean;
}

export interface F284WorkspaceSnapshot {
  threadId?: unknown;
  workspaceMode?: unknown;
  workspaceSurface?: unknown;
  workspaceOpenFilePath?: unknown;
  workspaceOpenFileLine?: unknown;
  workspaceWorktreeId?: unknown;
  workspacePreview?: unknown;
  teamWorkspaceSubject?: unknown;
  rightPanelOpen?: unknown;
}
