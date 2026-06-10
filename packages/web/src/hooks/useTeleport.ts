import { useEffect, useRef } from 'react';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { scrollToMessage } from '@/utils/scrollToMessage';
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
  },
): 'scrolled' | 'navigated' | 'ignored' {
  if (!data?.threadId || !data?.messageId) return 'ignored';
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
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    import('socket.io-client').then(({ io }) => {
      if (cancelled) return;
      const apiUrl = new URL(API_URL);
      const socket = io(`${apiUrl.protocol}//${apiUrl.host}`, { transports: ['websocket'] });
      socket.emit('join_room', 'workspace:global');

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
        });
      };

      socket.on('thread:teleport', handler);
      cleanup = () => {
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
