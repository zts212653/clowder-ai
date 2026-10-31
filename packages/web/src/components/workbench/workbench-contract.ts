import type { MessageMediaPublicationSource } from '@cat-cafe/shared';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import type { ArtifactFileEntrance } from './artifact-file-source';

export type WorkbenchSurfaceType =
  | 'agent-run'
  | 'artifact'
  | 'browser'
  | 'code'
  | 'content-editor'
  | 'evolution-program'
  | 'file'
  | 'review'
  | 'terminal'
  | 'thread-replay'
  | 'video-project'
  | 'workspace';

export type WorkbenchRenderer =
  | 'agent-run'
  | 'artifact-view'
  | 'browser-preview'
  | 'code-editor'
  | 'content-editor'
  | 'evolution-program'
  | 'file-preview'
  | 'review-summary'
  | 'terminal-session'
  | 'thread-replay'
  | 'video-project-review'
  | 'workspace-destination';

export type WorkbenchObjectKind =
  | 'agent-run'
  | 'artifact'
  | 'content-editor-session'
  | 'evolution-program'
  | 'file'
  | 'preview-session'
  | 'review'
  | 'terminal-session'
  | 'thread-replay'
  | 'video-project'
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
  /**
   * The ordinary user entry that opened an F063 file surface. Kept apart from
   * the content target and the Task-only entrusted-work return target.
   */
  navigationOrigin?: WorkspaceFileNavigationOrigin;
  /** Exact F232 entrance for explicit location recovery; never a file grant. */
  artifactFileSource?: ArtifactFileEntrance;
  /** Exact current directory selection for first connection; not an authorization. */
  rootSelection?: import('./workspace-root-selection').WorkspaceRootSelection;
  /** Reading state of the original artifact list, independent of content identity. */
  artifactListView?: import('@/components/artifacts/artifact-list-state').ArtifactListView;
  /** Files surface only: the path one explicit request asked to show in the tree. Never a grant. */
  filesReveal?: import('./files-tree').FilesRevealTarget;
  /**
   * Files surface only: the `/api/workspace/worktrees?repoRoot=` coordinate that minted its worktree id, when that
   * is not the current chat's project. Identity (branch/HEAD) is read through it; never a grant.
   */
  filesRepoRoot?: string;
  /** Exact original message item for explicit publication reselection; reauthorized by the resolver, never a grant. */
  messagePublicationSource?: MessageMediaPublicationSource;
  /** Navigation edge captured when this Artifact is opened from one exact entrusted-work item. */
  returnTargetRef?: { owner: string; key: string };
  capabilities: {
    split: boolean;
    sidecar: boolean;
    pin: boolean;
    /** Legacy schema-v2 hint. F307 now gives every mounted Workspace tab the same host-owned attention action. */
    mainAreaAttention?: true;
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
  /** One explicitly opened preview, persisted with the original working set. */
  previewSurfaceId: string | null;
  split: {
    primarySurfaceId: string;
    secondarySurfaceId: string;
  } | null;
  sidecar: WorkspaceSurfaceDescriptor | null;
  recentlyClosed: WorkspaceSurfaceDescriptor[];
  /** Canonical visit index, newest first per input host thread. Absent in older schema-v2 storage. */
  recentSurfaceIdsByThread?: Record<string, string[]>;
  activity: WorkbenchActivity[];
}

export interface FocusEntitlement {
  kind: 'user' | 'background';
  reason:
    | 'close-button'
    | 'bulk-close'
    | 'collapse-split'
    | 'explicit-split'
    | 'open-from-chat'
    | 'owner-background'
    | 'recently-closed'
    | 'return-origin'
    | 'review-ready'
    | 'sidecar-action'
    | 'surface-tab'
    | 'workspace-home-selection';
}

interface EntitledAction {
  entitlement: FocusEntitlement;
  /** Captured only by an explicit input producer; automatic foreground restoration leaves this absent. */
  visitThreadId?: string;
}

export type WorkbenchAction =
  | ({ type: 'open-surface'; surface: WorkspaceSurfaceDescriptor } & EntitledAction)
  | ({ type: 'open-preview-surface'; surface: WorkspaceSurfaceDescriptor } & EntitledAction)
  | ({ type: 'promote-preview-surface'; surfaceId: string } & EntitledAction)
  | { type: 'refresh-surface'; surface: WorkspaceSurfaceDescriptor }
  | { type: 'resolve-content-surface'; sourceSurfaceId: string; surface: WorkspaceSurfaceDescriptor }
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
  | ({ type: 'close-other-surfaces'; preserveSurfaceId: string } & EntitledAction)
  | ({ type: 'close-all-unpinned' } & EntitledAction)
  | ({ type: 'collapse-split' } & EntitledAction)
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
