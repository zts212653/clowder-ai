import { useEffect, useRef } from 'react';
import { openExactPlace } from '@/components/shell/mailbox/open-exact-place';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { joinSocketRoomOnConnect } from '@/utils/socket-room';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';

/**
 * F227: drive the Hub to an exact thread message in response to a `thread:teleport`
 * socket event (emitted by the cat_cafe_teleport MCP tool → POST /api/memory/teleport).
 *
 * Same thread  → scroll now (raf-retry until the bubble mounts).
 * Other thread → switch thread; planTeleport records the pending teleport and
 *                useChatHistory resolves + scrolls once the thread has rendered.
 * Takes a real messageId directly — no invocationId lookup (unlike cross-post).
 */

export interface TeleportEvent {
  threadId: string;
  messageId: string;
  eventId?: string;
  blockId?: string;
  source?: 'companion-decision';
}

/** A native approval link navigates only; the original card still owns the decision. */
function readCompanionDecisionLink(location: Pick<Location, 'pathname' | 'search' | 'hash'>): string | null {
  const thread = /^\/thread\/([A-Za-z0-9_-]{1,200})$/.exec(location.pathname)?.[1];
  const query = new URLSearchParams(location.search);
  const coordinate = /^[A-Za-z0-9_-]{1,200}$/;
  const message = query.get('message');
  const block = query.get('block');
  if (
    !thread ||
    location.hash ||
    !message ||
    !coordinate.test(message) ||
    query.getAll('message').length !== 1 ||
    query.getAll('block').length > 1 ||
    (block !== null && !coordinate.test(block)) ||
    [...query.keys()].some((key) => key !== 'message' && key !== 'block')
  )
    return null;
  return `message:${thread}:${message}${block === null ? '' : `#${block}`}`;
}

export function handleTeleportEvent(
  data: TeleportEvent,
  currentThreadId: string | null,
  actions: {
    /**
     * Cross-thread navigation: must change the URL so the `(chat)` layout's
     * URL-derived `threadId` updates and `useChatHistory` mounts for the new
     * thread. Use `pushThreadRouteWithHistory(threadId, window)` — not a bare
     * Zustand `setCurrentThread`, which only mutates the store and leaves the
     * route (and the pending teleport resolve) stuck on the old thread.
     */
    pushThreadRoute: (threadId: string) => void;
    scrollToMessage: (messageId: string) => void;
    openSourceAction?: (actionRef: string) => boolean;
  },
): 'scrolled' | 'navigated' | 'ignored' {
  if (!data?.threadId || !data?.messageId) return 'ignored';
  if (data.blockId !== undefined || data.source === 'companion-decision') {
    if (data.blockId !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(data.blockId)) return 'ignored';
    return actions.openSourceAction?.(
      `message:${data.threadId}:${data.messageId}${data.blockId ? `#${data.blockId}` : ''}`,
    )
      ? 'navigated'
      : 'ignored';
  }
  const plan = planTeleport({ threadId: data.threadId, messageId: data.messageId, currentThreadId });
  if (plan.scrollNow) {
    actions.scrollToMessage(plan.scrollNow);
    // P1 (砚砚 R1): same-thread — if the target is outside the loaded window, nudge
    // useChatHistory to run its older-page resolver (planTeleport recorded a pending).
    kickTeleportResolve();
    return 'scrolled';
  }
  if (plan.navigateTo) {
    actions.pushThreadRoute(plan.navigateTo);
    return 'navigated';
  }
  return 'ignored';
}

/**
 * Same-thread teleport: the bubble is usually already mounted, but a long /
 * virtualized list may need a few frames. Retry on raf until found or a short cap.
 */
function scrollToMessageWithRetry(messageId: string, maxFrames = 60): void {
  if (scrollToMessage(messageId)) return;
  let frames = 0;
  const tick = (): void => {
    frames += 1;
    if (scrollToMessage(messageId) || frames >= maxFrames) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function useTeleport(): void {
  const lastEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    const initialSource = readCompanionDecisionLink(window.location);
    if (initialSource) {
      // The newly activated browser need not have been connected to the socket.
      // Reuse the same history recovery and rich-card reveal as the 待办 panel.
      openExactPlace(initialSource, window.location.pathname);
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    import('socket.io-client').then(({ io }) => {
      if (cancelled) return;
      const apiUrl = new URL(API_URL);
      const socket = io(`${apiUrl.protocol}//${apiUrl.host}`, { transports: ['websocket'] });
      const stopJoiningRoom = joinSocketRoomOnConnect(socket, 'workspace:global');

      const handler = (data: TeleportEvent) => {
        // Dedup: the socket may redeliver the same teleport event.
        if (data.eventId && data.eventId === lastEventIdRef.current) return;
        if (data.eventId) lastEventIdRef.current = data.eventId;
        handleTeleportEvent(data, useChatStore.getState().currentThreadId, {
          // URL-based navigation: changes the route so the (chat) layout's
          // URL-derived threadId updates, useChatHistory mounts for the new
          // thread, and resolvePendingTeleport fires after render.
          pushThreadRoute: (tid) => pushThreadRouteWithHistory(tid, window),
          scrollToMessage: scrollToMessageWithRetry,
          openSourceAction: (actionRef) => {
            openExactPlace(actionRef, window.location.pathname);
            return true;
          },
        });
      };

      socket.on('thread:teleport', handler);
      cleanup = () => {
        stopJoiningRoom();
        socket.off('thread:teleport', handler);
        socket.disconnect();
      };
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []); // no reactive deps — reads store via getState() in handler
}
