import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';

export type WorkspaceFileReturnAction =
  | Extract<WorkspaceFileNavigationOrigin, { kind: 'artifact-list' }>
  | Extract<WorkspaceFileNavigationOrigin, { kind: 'workspace-document' }>
  | Extract<WorkspaceFileNavigationOrigin, { kind: 'settings' | 'workspace-card' }>
  | { readonly kind: 'file-tree'; readonly worktreeId: string; readonly repoRoot?: string }
  | { readonly kind: 'workspace-home-search'; readonly query: string }
  | { readonly kind: 'chat-file-link'; readonly threadId: string; readonly messageId: string };

/** Translate a typed ordinary-file origin into an executable host navigation action. */
export function workspaceFileReturnAction(
  origin: Exclude<WorkspaceFileNavigationOrigin, { kind: 'evolution-media' }>,
  worktreeId: string,
): WorkspaceFileReturnAction {
  if (origin.kind === 'artifact-list') return origin;
  // Return to the tree that was browsed; the file itself may since have been re-keyed to its canonical root.
  if (origin.kind === 'file-tree') {
    // The tree's listing coordinate belongs to the browsed id only; a re-keyed fallback id never borrows it.
    if (!origin.worktreeId) return { kind: 'file-tree', worktreeId };
    return {
      kind: 'file-tree',
      worktreeId: origin.worktreeId,
      ...(origin.repoRoot ? { repoRoot: origin.repoRoot } : {}),
    };
  }
  if (origin.kind === 'workspace-document') return origin;
  if (origin.kind === 'settings' || origin.kind === 'workspace-card') return origin;
  if (origin.kind === 'workspace-home-search') return { kind: 'workspace-home-search', query: origin.query };
  return { kind: 'chat-file-link', threadId: origin.threadId, messageId: origin.messageId };
}
