'use client';

import { useCallback, useEffect } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { type ToastItem, useToastStore } from '@/stores/toastStore';

const DISMISS_DELAY = 300; // animation duration

function ToastCard({ toast }: { toast: ToastItem }) {
  const { removeToast, markExiting } = useToastStore();

  const dismiss = useCallback(() => {
    markExiting(toast.id);
    setTimeout(() => removeToast(toast.id), DISMISS_DELAY);
  }, [toast.id, markExiting, removeToast]);

  // Use remaining lifetime so toasts that were hidden (thread-scoped, other
  // thread active) don't restart their full duration when they become visible.
  useEffect(() => {
    if (toast.duration <= 0) return;
    const remaining = toast.duration - (Date.now() - toast.createdAt);
    if (remaining <= 0) {
      dismiss();
      return;
    }
    const timer = setTimeout(dismiss, remaining);
    return () => clearTimeout(timer);
  }, [toast.duration, toast.createdAt, dismiss]);

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

  return (
    <div
      className={`
        bg-cafe-surface rounded-lg shadow-lg border border-cafe-subtle border-l-4 ${borderColor}
        px-4 py-3 max-w-xs pointer-events-auto
        ${toast.exiting ? 'animate-toast-out' : 'animate-toast-in'}
      `}
      role="alert"
    >
      <div className="flex items-start gap-2">
        <span className={`text-sm flex-shrink-0 mt-0.5 ${icon}`}>
          {toast.type === 'error' ? 'ᓚᘏᗢ' : toast.type === 'success' ? 'ᓚᘏᗢ' : 'ᓚᘏᗢ'}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-cafe truncate">{toast.title}</p>
          <p className="text-xs text-cafe-secondary mt-0.5 line-clamp-2">{toast.message}</p>
        </div>
        <button
          onClick={dismiss}
          className="text-cafe-muted hover:text-cafe-secondary flex-shrink-0 p-0.5"
          title="关闭"
          aria-label="关闭"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 14 14" fill="currentColor">
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
  toasts: ReadonlyArray<Pick<ToastItem, 'id' | 'threadId' | 'duration' | 'createdAt'>>,
  currentThreadId: string | null,
  now: number,
): { expired: string[]; nextMs: number | null } {
  const expired: string[] = [];
  let nextMs: number | null = null;
  for (const t of toasts) {
    if (t.threadId && t.threadId !== currentThreadId && t.duration > 0) {
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
      {visible.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
