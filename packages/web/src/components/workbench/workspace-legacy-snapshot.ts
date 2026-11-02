import type { ChatState } from '@/stores/chatStore';
import type { F284WorkspaceSnapshot } from './workbench-contract';

type WorkspaceState = Pick<
  ChatState,
  | 'workspaceMode'
  | 'workspaceSurface'
  | 'workspaceOpenFilePath'
  | 'workspaceOpenFileLine'
  | 'workspaceWorktreeId'
  | 'workspacePreview'
  | 'teamWorkspaceSubject'
>;

/** The host and a pre-mount explicit entry must supply the same legacy migration input. */
export function readF284WorkspaceSnapshot(
  state: WorkspaceState,
  pendingFileLink: boolean,
  threadId?: string,
): F284WorkspaceSnapshot | undefined {
  const {
    workspaceMode,
    workspaceSurface,
    workspaceOpenFilePath,
    workspaceOpenFileLine,
    workspaceWorktreeId,
    workspacePreview,
    teamWorkspaceSubject,
  } = state;
  if (
    pendingFileLink ||
    !(
      workspaceMode === 'team' ||
      (workspaceSurface === 'files' && workspaceOpenFilePath) ||
      (workspaceSurface === 'browser' && workspacePreview.port)
    )
  )
    return undefined;
  return {
    threadId,
    workspaceMode,
    workspaceSurface,
    workspaceOpenFilePath,
    workspaceOpenFileLine,
    workspaceWorktreeId,
    workspacePreview,
    teamWorkspaceSubject,
    rightPanelOpen: true,
  };
}
