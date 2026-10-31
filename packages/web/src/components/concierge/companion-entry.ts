import { useConciergeStore } from '@/stores/conciergeStore';
import { pushThreadRouteWithHistory } from '../ThreadSidebar/thread-navigation';

let opening: Promise<boolean> | undefined;

/** Explicit navigation uses the existing carrier, draft owner and browser return history. */
export function openCompanionConversation(): Promise<boolean> {
  if (opening) return opening;
  const originalUrl = typeof window === 'undefined' ? undefined : window.location.href;
  const operation = (async () => {
    const threadId = await useConciergeStore.getState().fetchThreadId({ refresh: true });
    if (!threadId) return false;
    if (originalUrl && window.location.href !== originalUrl) return false;
    // Keep an explicit capability-tip prompt until the canonical composer consumes it.
    useConciergeStore.setState({ surfaceState: 'collapsed', inputFocused: false });
    pushThreadRouteWithHistory(threadId, typeof window === 'undefined' ? undefined : window);
    return true;
  })();
  opening = operation;
  void operation.finally(() => {
    if (opening === operation) opening = undefined;
  });
  return operation;
}
