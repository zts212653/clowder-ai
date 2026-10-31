import type { ChatState } from '@/stores/chatStore';

/** A Chat link remains pending through cold mounting, but a newer navigation always wins. */
export function hasPendingWorkspaceFileLink(
  state: Pick<ChatState, '_workspaceFileSetAt' | 'workspaceOpenRevision' | 'currentThreadId'>,
): boolean {
  const stamp = state._workspaceFileSetAt;
  return (
    stamp.disposition === 'permanent' &&
    !stamp.consumed &&
    stamp.revision === state.workspaceOpenRevision &&
    (!stamp.threadId || stamp.threadId === state.currentThreadId)
  );
}
