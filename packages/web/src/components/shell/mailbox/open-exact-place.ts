import { getThreadIdFromPathname, pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { navigateToEntrustedWorkAction, resolveEntrustedWorkActionTarget } from '@/hooks/useWorkspaceNavigate';
import { useChatStore } from '@/stores/chatStore';

const isChatRoute = (pathname: string) => pathname === '/' || pathname.startsWith('/thread/');

/**
 * Open an exact place from the 待办 panel, wherever the user is.
 *
 * `navigateToEntrustedWorkAction` records the coordinate and then decides between "scroll here" and "go to that
 * conversation" from the REMEMBERED conversation (`chatStore.currentThreadId`), which the app keeps after you leave a chat for
 * /settings or /memory. So from such a page, a source in the conversation you last had open is taken as "already here": it
 * records the coordinate, tries to scroll, and the page never moves. The panel is the consumer that knows the real page, so
 * it routes in that one case; the arriving conversation then reveals the stored message and block through the existing
 * pending-action chain. Every other case is already routed by the function itself (pushing again would only repeat the
 * same navigation), and inside the right conversation it is only a scroll.
 */
export function openExactPlace(actionRef: string, pathname: string): void {
  const target = resolveEntrustedWorkActionTarget(actionRef);
  const rememberedThreadId = useChatStore.getState().currentThreadId;
  navigateToEntrustedWorkAction(actionRef);
  if (target?.kind !== 'message' || rememberedThreadId !== target.threadId) return;
  const hostedThreadId = isChatRoute(pathname) ? getThreadIdFromPathname(pathname) : null;
  if (hostedThreadId !== target.threadId) pushThreadRouteWithHistory(target.threadId, window);
}
