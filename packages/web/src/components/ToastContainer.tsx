'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { type ToastItem, useToastStore } from '@/stores/toastStore';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';
import { LongFormReader } from './content-overflow';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';

const DISMISS_DELAY = 300; // animation duration

interface ToastCardProps {
  toast: ToastItem;
  onDismiss?: () => void;
  stackPosition?: number;
  stackSize?: number;
}

export function ToastCard({ toast, onDismiss, stackPosition, stackSize }: ToastCardProps) {
  const { removeToast, markExiting, disableAutoDismiss } = useToastStore();
  const [autoDismissDisabled, setAutoDismissDisabled] = useState(Boolean(toast.manualDismissOnly));
  const removalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stackContext =
    stackPosition && stackSize && stackSize > 1 ? `，第 ${stackPosition} 条，共 ${stackSize} 条` : '';

  const cancelPendingRemoval = useCallback(() => {
    if (removalTimerRef.current === null) return;
    clearTimeout(removalTimerRef.current);
    removalTimerRef.current = null;
  }, []);

  const dismiss = useCallback(() => {
    if (onDismiss) {
      onDismiss();
      return;
    }
    cancelPendingRemoval();
    markExiting(toast.id);
    removalTimerRef.current = setTimeout(() => {
      removalTimerRef.current = null;
      removeToast(toast.id);
    }, DISMISS_DELAY);
  }, [cancelPendingRemoval, toast.id, markExiting, onDismiss, removeToast]);

  useEffect(() => {
    if (toast.manualDismissOnly) setAutoDismissDisabled(true);
  }, [toast.manualDismissOnly]);

  useEffect(() => cancelPendingRemoval, [cancelPendingRemoval]);

  // Use remaining lifetime so toasts that were hidden (thread-scoped, other
  // thread active) don't restart their full duration when they become visible.
  useEffect(() => {
    if (toast.duration <= 0 || autoDismissDisabled) return;
    const remaining = toast.duration - (Date.now() - toast.createdAt);
    if (remaining <= 0) {
      dismiss();
      return;
    }
    const timer = setTimeout(dismiss, remaining);
    return () => clearTimeout(timer);
  }, [toast.duration, toast.createdAt, dismiss, autoDismissDisabled]);

  const handleReaderOpenChange = useCallback(
    (open: boolean) => {
      if (!open) return;
      cancelPendingRemoval();
      setAutoDismissDisabled(true);
      disableAutoDismiss(toast.id);
    },
    [cancelPendingRemoval, disableAutoDismiss, toast.id],
  );

  const borderColor =
    toast.type === 'error'
      ? 'border-l-conn-red-ring'
      : toast.type === 'success'
        ? 'border-l-conn-green-ring'
        : 'border-l-conn-amber-ring';

  const icon =
    toast.type === 'error'
      ? 'text-conn-red-text'
      : toast.type === 'success'
        ? 'text-green-500'
        : 'text-conn-amber-text';

  const runAction = useCallback(() => {
    const action = toast.action;
    if (!action) return;
    if (!action.messageId) {
      pushThreadRouteWithHistory(action.threadId, typeof window === 'undefined' ? undefined : window);
      dismiss();
      return;
    }
    const plan = planTeleport({
      threadId: action.threadId,
      messageId: action.messageId,
      currentThreadId: useChatStore.getState().currentThreadId,
    });
    if (plan.scrollNow) {
      scrollToMessage(plan.scrollNow);
      kickTeleportResolve();
    } else if (plan.navigateTo) {
      pushThreadRouteWithHistory(plan.navigateTo, typeof window === 'undefined' ? undefined : window);
    }
    dismiss();
  }, [dismiss, toast.action]);

  return (
    <div
      className={`
        bg-cafe-surface rounded-lg shadow-lg border border-cafe-subtle border-l-4 ${borderColor}
        px-3 py-2.5 max-h-[70vh] max-w-xs overflow-y-auto pointer-events-auto
        ${toast.exiting ? 'animate-toast-out' : 'animate-toast-in'}
      `}
      role="alert"
    >
      <div className="flex items-start gap-2">
        <span className={`text-sm flex-shrink-0 mt-0.5 ${icon}`}>
          {toast.type === 'error' ? 'ᓚᘏᗢ' : toast.type === 'success' ? 'ᓚᘏᗢ' : 'ᓚᘏᗢ'}
        </span>
        <div data-testid="toast-content" className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium leading-5 text-cafe">{toast.title}</p>
          <LongFormReader
            title={toast.title}
            summary={toast.message}
            accessibleSummary="通知包含较长内容，完整内容请使用查看全文按钮。"
            content={toast.message}
            density="compact"
            className="mt-0.5"
            summaryClassName="whitespace-pre-wrap break-words text-xs leading-5 text-cafe-secondary"
            triggerAriaLabel={`查看“${toast.title}”通知全文${stackContext}`}
            onOpenChange={handleReaderOpenChange}
          />
          {toast.action ? (
            <button
              type="button"
              className="mt-1.5 rounded-md border border-cafe px-2 py-1 text-xs font-semibold text-cafe-interactive hover:bg-cafe-surface-sunken"
              onClick={runAction}
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="text-cafe-muted hover:text-cafe-secondary flex-shrink-0 p-0.5"
          title="关闭"
          aria-label={`关闭“${toast.title}”通知${stackContext}`}
        >
          <svg aria-hidden="true" className="w-3.5 h-3.5" viewBox="0 0 14 14" fill="currentColor">
            <path d="M4.293 4.293a1 1 0 011.414 0L7 5.586l1.293-1.293a1 1 0 111.414 1.414L8.414 7l1.293 1.293a1 1 0 01-1.414 1.414L7 8.414 5.707 9.707a1 1 0 01-1.414-1.414L5.586 7 4.293 5.707a1 1 0 010-1.414z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/**
 * Compute which hidden (non-current-thread) toasts have expired and when the
 * next one will expire.  Pure function — extracted for testability.
 */
export function getHiddenToastExpiries(
  toasts: ReadonlyArray<Pick<ToastItem, 'id' | 'threadId' | 'duration' | 'createdAt' | 'manualDismissOnly'>>,
  currentThreadId: string | null,
  now: number,
): { expired: string[]; nextMs: number | null } {
  const expired: string[] = [];
  let nextMs: number | null = null;
  for (const t of toasts) {
    if (t.threadId && t.threadId !== currentThreadId && t.duration > 0 && !t.manualDismissOnly) {
      const remaining = t.duration - (now - t.createdAt);
      if (remaining <= 0) {
        expired.push(t.id);
      } else if (nextMs === null || remaining < nextMs) {
        nextMs = remaining;
      }
    }
  }
  return { expired, nextMs };
}

/**
 * Filter toasts by the active thread.
 * - Toasts with no threadId (global) are always shown.
 * - Toasts with a threadId only show when that thread is active (#924).
 */
export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);
  const currentThreadId = useChatStore((s) => s.currentThreadId);

  // P2 review fix: expire hidden thread-scoped toasts whose ToastCard never
  // mounted (so their per-card timer never started). Immediately removes any
  // already-expired hidden toasts, then schedules a timer for the next one.
  useEffect(() => {
    const { expired, nextMs } = getHiddenToastExpiries(toasts, currentThreadId, Date.now());
    for (const id of expired) removeToast(id);

    if (nextMs !== null) {
      const timer = setTimeout(() => {
        // Re-scan: the closure's `toasts` may be stale, but removeToast by id
        // is idempotent and the resulting store mutation re-triggers this effect.
        const { expired: due } = getHiddenToastExpiries(toasts, currentThreadId, Date.now());
        for (const id of due) removeToast(id);
      }, nextMs + 16); // +16ms to land past the expiry boundary
      return () => clearTimeout(timer);
    }
  }, [toasts, currentThreadId, removeToast]);

  const visible = toasts.filter((t) => !t.threadId || t.threadId === currentThreadId);

  if (visible.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {visible.map((toast, index) => (
        <ToastCard key={toast.id} toast={toast} stackPosition={index + 1} stackSize={visible.length} />
      ))}
    </div>
  );
}
