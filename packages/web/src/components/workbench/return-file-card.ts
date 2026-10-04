import { CHAT_THREAD_ROUTE_EVENT } from '@/components/ThreadSidebar/thread-navigation';
import { useChatStore } from '@/stores/chatStore';
import { FILE_RETURN_EVENT, type FileCardOrigin, fileCardReturnHref } from './file-card-origin';
import { createWorkspaceDestinationSurface, createWorkspaceModeSurface } from './real-surface-adapters';
import type { WorkbenchAction } from './workbench-contract';

export function returnFileCard(
  origin: FileCardOrigin,
  navigate: (href: string) => void,
  dispatch: (action: WorkbenchAction) => void,
) {
  const href = fileCardReturnHref(origin);
  if (origin.kind === 'settings') {
    navigate(href);
    return;
  }
  const store = useChatStore.getState();
  if (store.currentThreadId !== origin.threadId) store.setCurrentThread(origin.threadId);
  const surface =
    origin.destination === 'eval'
      ? createWorkspaceModeSurface('eval', origin.threadId)
      : createWorkspaceDestinationSurface(
          { kind: 'host', id: 'status', label: '状态与会话', description: '当前对话的运行状态', searchTerms: 'status' },
          origin.threadId,
        );
  if (!surface) return;
  const target = new URL(href, window.location.origin);
  if (window.location.pathname !== target.pathname) {
    window.history.pushState(window.history.state, '', href);
    window.dispatchEvent(new Event(CHAT_THREAD_ROUTE_EVENT));
  } else window.history.replaceState(window.history.state, '', href);
  dispatch({ type: 'open-surface', surface, entitlement: { kind: 'user', reason: 'return-origin' } });
  window.dispatchEvent(new Event(FILE_RETURN_EVENT));
}
