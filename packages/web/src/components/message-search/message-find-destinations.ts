import { assignDocumentRoute } from '@/components/ThreadSidebar/thread-navigation';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createWorkspaceDestinationSurface } from '@/components/workbench/real-surface-adapters';
import { rememberWorkspaceForeground } from '@/components/workbench/workspace-presentation-lock';
import { useChatStore } from '@/stores/chatStore';
import type { MessageFindContext } from './message-find-state';
import type { MessageReadingSession } from './message-reading-session';

/** Chrome coordinates only; the original reader still owns every reading position. */
export function captureFindWorkspaceOrigin(): MessageFindContext['workspaceOrigin'] {
  const chat = useChatStore.getState();
  return {
    open: chat.rightPanelOpen,
    mode: chat.rightPanelMode,
    surfaceId: chat.workspaceForegroundSurfaceId ?? null,
  };
}

export function openMessageFindDestination(session: MessageReadingSession): void {
  const { find, trip } = session;
  if (!find) return;
  if (find.destination === 'memory') {
    const params = new URLSearchParams({ from: trip.origin.threadId, q: find.state.query, findSession: session.id });
    assignDocumentRoute(`/memory?${params}`, window);
    return;
  }
  const chat = useChatStore.getState();
  const store = useF307ExperienceWorkbenchStore.getState();
  const surface = createWorkspaceDestinationSurface(
    { kind: 'mode', id: 'artifacts', label: '作品', description: '搜索作品名称', searchTerms: '作品' },
    trip.origin.threadId,
    chat.workspaceWorktreeId,
  );
  if (!surface) return;
  chat.setWorkspaceMode('dev');
  store.exitMainAreaAttention();
  store.dispatch({
    type: 'open-surface',
    surface: {
      ...surface,
      artifactListView: {
        scope: find.state.scope,
        filter: 'all',
        query: find.state.query,
        grouping: 'time',
        catFilter: null,
        collapsed: [],
        findSessionId: session.id,
      },
    },
    entitlement: { kind: 'user', reason: 'open-from-chat' },
  });
  // The panel may mount only after this entry. Use its existing foreground bridge
  // explicitly so an unmounted subscription cannot leave the user on Home.
  rememberWorkspaceForeground();
}

export function restoreFindWorkspaceOrigin(session: MessageReadingSession): void {
  const saved = session.find?.workspaceOrigin;
  if (!saved) return;
  const store = useF307ExperienceWorkbenchStore.getState();
  store.exitMainAreaAttention();
  if (saved.surfaceId && store.layout.surfaces.some((surface) => surface.id === saved.surfaceId)) {
    store.dispatch({
      type: 'activate-surface',
      surfaceId: saved.surfaceId,
      entitlement: { kind: 'user', reason: 'open-from-chat' },
    });
    rememberWorkspaceForeground();
  } else if (saved.surfaceId === null) {
    useChatStore.getState().setWorkspaceForegroundSurfaceId(null);
  }
  const chat = useChatStore.getState();
  if (saved.mode) chat.setRightPanelMode(saved.mode);
  chat.setRightPanelOpen(saved.open);
}
