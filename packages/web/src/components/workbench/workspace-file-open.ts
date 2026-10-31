import type { WorkspaceOpenRequest } from '@/stores/chat-types';
import type { ChatState } from '@/stores/chatStore';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import { createFilePreviewSurface, createFileSurface, resolveFileTarget } from './real-surface-adapters';

export function canConsumeWorkspaceFileStamp({
  stamp,
  pendingFileLink,
  lastTimestamp,
  hydrated,
  threadId,
}: {
  stamp: ChatState['_workspaceFileSetAt'];
  pendingFileLink: boolean;
  lastTimestamp: number;
  hydrated: boolean;
  threadId: string | null;
}): boolean {
  const requested = stamp.disposition === 'permanent' ? pendingFileLink : stamp.ts !== lastTimestamp;
  return requested && hydrated && (!stamp.threadId || stamp.threadId === threadId);
}

/** A file link is permanent intent; presentation chooses only the default for unqualified navigation. */
export function openWorkspaceFileStamp(
  input: Parameters<typeof createFileSurface>[0],
  isV2: boolean,
  disposition?: WorkspaceOpenRequest['disposition'],
  visitThreadId?: string,
): void {
  const store = useF307ExperienceWorkbenchStore.getState();
  const permanent = disposition === 'permanent';
  const perFile = isV2 || permanent;
  const surface = (perFile ? createFilePreviewSurface : createFileSurface)(input);
  const existing = perFile
    ? store.layout.surfaces.find((candidate) => {
        const target = resolveFileTarget(candidate);
        return target?.worktreeId === input.worktreeId && target.path === input.path;
      })
    : undefined;
  if (existing) {
    // Reuse a legacy root-scoped tab or a preview of this exact file, without rewriting its durable identity.
    surface.id = existing.id;
    surface.objectRef = existing.objectRef;
    if (permanent && store.layout.previewSurfaceId === existing.id) {
      store.dispatch({
        type: 'promote-preview-surface',
        surfaceId: existing.id,
        entitlement: { kind: 'user', reason: 'open-from-chat' },
        visitThreadId,
      });
    }
  }
  store.dispatch({
    type: isV2 && !permanent ? 'open-preview-surface' : 'open-surface',
    surface,
    entitlement: { kind: 'user', reason: 'open-from-chat' },
    visitThreadId,
  });
}
