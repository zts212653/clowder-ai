import { createFileSurface, normalizeFileScrollToLine } from './real-surface-adapters';
import type { F284WorkspaceSnapshot, WorkbenchLayoutState, WorkspaceSurfaceDescriptor } from './workbench-contract';
import { createInitialWorkbenchState } from './workbench-initial-state';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

function warning(id: string, message: string) {
  return { id, kind: 'restore-warning' as const, message };
}

function failedMigration(id: string): WorkbenchLayoutState {
  return {
    ...createInitialWorkbenchState(),
    activity: [warning(id, 'Workspace 状态无法迁移，已恢复为安全空态。')],
  };
}

function migratedCapabilities(): WorkspaceSurfaceDescriptor['capabilities'] {
  return {
    split: true,
    sidecar: true,
    pin: true,
    closePolicy: 'detach-host',
    restorePolicy: 'descriptor',
  };
}

function migrateFile(snapshot: F284WorkspaceSnapshot): WorkspaceSurfaceDescriptor | null {
  if (!isNonEmptyString(snapshot.workspaceOpenFilePath)) return null;
  const worktreeId = isNonEmptyString(snapshot.workspaceWorktreeId) ? snapshot.workspaceWorktreeId : 'worktree-main';
  return createFileSurface({
    worktreeId,
    path: snapshot.workspaceOpenFilePath,
    scrollToLine: normalizeFileScrollToLine(snapshot.workspaceOpenFileLine),
  });
}

function migrateBrowser(snapshot: F284WorkspaceSnapshot): WorkspaceSurfaceDescriptor | null {
  const preview = asRecord(snapshot.workspacePreview);
  const port = typeof preview?.port === 'number' && Number.isInteger(preview.port) ? preview.port : null;
  const path = isNonEmptyString(preview?.path) ? preview.path : '/';
  if (port === null || port < 1 || port > 65_535) return null;
  const ownerKey = isNonEmptyString(snapshot.workspaceWorktreeId) ? snapshot.workspaceWorktreeId : 'current-project';
  return {
    id: `browser-owner:${ownerKey}`,
    type: 'browser',
    renderer: 'browser-preview',
    title: `localhost:${port}`,
    context: `${path} · managed preview`,
    objectRef: { kind: 'preview-session', id: ownerKey },
    ownerStateRef: { owner: 'f120-browser-preview', key: ownerKey },
    resultTargetRef: { owner: 'f120-browser-preview', key: `${port}:${path}` },
    capabilities: migratedCapabilities(),
  };
}

function migrateTeam(snapshot: F284WorkspaceSnapshot): WorkspaceSurfaceDescriptor {
  const rawSubject = asRecord(snapshot.teamWorkspaceSubject);
  const subject =
    (rawSubject?.type === 'cat' || rawSubject?.type === 'provider') && isNonEmptyString(rawSubject.id)
      ? { type: rawSubject.type, id: rawSubject.id }
      : null;
  const ownerKey = isNonEmptyString(snapshot.threadId) ? snapshot.threadId : 'global';
  return {
    id: `workspace:mode:team:${ownerKey}`,
    type: 'workspace',
    renderer: 'workspace-destination',
    title: '猫猫团队',
    context: subject ? `${subject.type} · ${subject.id}` : '成员能力、当前路由状态与协作偏好',
    objectRef: { kind: 'workspace-destination', id: 'mode:team' },
    ownerStateRef: { owner: 'f293-routing-context', key: ownerKey },
    resultTargetRef: {
      owner: 'f293-routing-context',
      key: subject ? encodeURIComponent(JSON.stringify(subject)) : 'list',
    },
    capabilities: migratedCapabilities(),
  };
}

export function migrateF284WorkspaceState(value: unknown): WorkbenchLayoutState {
  const snapshot = asRecord(value) as F284WorkspaceSnapshot | null;
  if (snapshot === null) return failedMigration('migration:invalid-f284');
  if (snapshot.workspaceMode === 'collective') {
    return {
      ...createInitialWorkbenchState(),
      activity: [warning('migration:ignored-f290', '已忽略被否决的 Collective 工作集状态。')],
    };
  }
  const migrated =
    snapshot.workspaceMode === 'team'
      ? migrateTeam(snapshot)
      : snapshot.workspaceSurface === 'files'
        ? migrateFile(snapshot)
        : snapshot.workspaceSurface === 'browser'
          ? migrateBrowser(snapshot)
          : null;
  if (migrated === null) return failedMigration('migration:unsupported-f284');
  const state = createInitialWorkbenchState([migrated]);
  return snapshot.rightPanelOpen === false
    ? { ...state, activity: [warning('migration:folded', '已恢复上次工作；工作台仍保持收起。')] }
    : state;
}
