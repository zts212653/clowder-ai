import { useEffect, useRef } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import {
  deliverPreviewAutoOpenEvent,
  isPreviewWorktreeScopeAcceptable,
  type PreviewAutoOpenEvent,
  type PreviewAutoOpenReceipt,
} from './preview-auto-open-delivery';

/**
 * Legacy fail-closed filter (worktree scope + same-thread). Kept for
 * backwards-compatible tests; the live hook routes cross-thread events to the
 * delivery contract (queued into the target thread) and worktree-mismatched
 * applies to a skipped receipt — see deliverPreviewAutoOpenEvent.
 */
export function shouldAcceptAutoOpen(
  sessionWorktreeId: string | null,
  eventWorktreeId: string | undefined,
  sessionThreadId: string,
  eventThreadId: string | undefined,
): boolean {
  if (eventThreadId && eventThreadId !== sessionThreadId) {
    return false;
  }
  return isPreviewWorktreeScopeAcceptable(sessionWorktreeId, eventWorktreeId);
}

/**
 * F120: Always-mounted socket listener for preview:auto-open events.
 *
 * Problem: WorkspacePanel only mounts when rightPanelMode='workspace'.
 * When user is in status bar mode, auto-open events are lost.
 *
 * Solution: This hook mounts in ChatContainer (always rendered),
 * stores pending auto-open in the store, and switches to workspace mode.
 * WorkspacePanel then consumes the pending state on mount.
 *
 * F120 × F284: delivery receipts. The server emits the event ONLY to the
 * caller's user room with an ack callback — every socket auto-joins its own
 * user:<userId> room at connect, so no explicit room join is needed (and no
 * preview:global/worktree broadcast exists anymore: those rooms leaked the
 * event to non-caller observers). Every accepted event gets an explicit
 * receipt (applied / queued / blocked / skipped). Events targeting another
 * thread are queued into that thread's ThreadState so returning to it
 * reveals the preview, instead of being dropped.
 */
export function usePreviewAutoOpen(worktreeId: string | null, threadId: string) {
  const setPendingPreviewAutoOpen = useChatStore((s) => s.setPendingPreviewAutoOpen);
  const queueThreadPreview = useChatStore((s) => s.queueThreadPreview);
  const lastEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    import('socket.io-client').then(({ io }) => {
      if (cancelled) return;
      const apiUrl = new URL(API_URL);
      const socket = io(`${apiUrl.protocol}//${apiUrl.host}`, { transports: ['websocket'] });

      const handler = (data: PreviewAutoOpenEvent, acknowledge?: (receipt: PreviewAutoOpenReceipt) => void) => {
        // The server emits one copy per event; duplicates across reconnects or
        // replays are deduped by eventId, but a copy carrying `acknowledge`
        // must ALWAYS be answered — skipping it would leave the server at
        // unconfirmed.
        if (!acknowledge && data.eventId && data.eventId === lastEventIdRef.current) return;
        if (data.eventId) lastEventIdRef.current = data.eventId;
        const receipt = deliverPreviewAutoOpenEvent({
          data,
          activeThreadId: threadId,
          presentationLocked: useChatStore.getState().presentationLock != null,
          sessionWorktreeId: worktreeId,
          // Inactive targets are judged by their OWN saved worktree scope, not
          // by the foreground thread's (review round-3 P1).
          resolveTargetWorktreeId: (targetThreadId) => {
            const target = useChatStore.getState().threadStates[targetThreadId];
            return target ? (target.workspaceWorktreeId ?? null) : undefined;
          },
          apply: (event) => setPendingPreviewAutoOpen({ port: event.port, path: event.path ?? '/' }),
          queueForThread: (targetThreadId, preview) => queueThreadPreview(targetThreadId, preview),
        });
        acknowledge?.(receipt);
      };

      socket.on('preview:auto-open', handler);

      cleanup = () => {
        socket.off('preview:auto-open', handler);
        socket.disconnect();
      };
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [threadId, worktreeId, setPendingPreviewAutoOpen, queueThreadPreview]);
}
