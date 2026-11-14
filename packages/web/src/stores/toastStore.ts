'use client';

import { create } from 'zustand';

export interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'info';
  title: string;
  message: string;
  threadId?: string;
  /** Optional exact navigation affordance rendered below the toast body. */
  action?: { label: string; threadId: string; messageId?: string };
  /** Auto-dismiss after ms (0 = no auto-dismiss) */
  duration: number;
  createdAt: number;
  /** Set true when exit animation starts */
  exiting?: boolean;
  /** The reader was opened, so this toast now requires an explicit dismissal. */
  manualDismissOnly?: boolean;
  /** Retain owner-managed status notices when the transient queue fills. */
  pinned?: boolean;
  /** Let clicks pass through status text while keeping its buttons interactive. */
  passThrough?: boolean;
}

interface ToastState {
  toasts: ToastItem[];
  addToast: (toast: Omit<ToastItem, 'id' | 'createdAt' | 'manualDismissOnly'>) => string;
  removeToast: (id: string) => void;
  markExiting: (id: string) => void;
  disableAutoDismiss: (id: string) => void;
}

let nextId = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  addToast: (toast) => {
    const id = `toast-${++nextId}-${Date.now()}`;
    const item: ToastItem = { ...toast, id, createdAt: Date.now() };
    set((state) => {
      const next = [...state.toasts, item];
      let transientToEvict = Math.max(
        0,
        next.filter((candidate) => !candidate.manualDismissOnly && !candidate.pinned).length - 10,
      );
      return {
        // Reader-opened toasts are user-held state. Keep them until explicit
        // dismissal; owner-managed status stays until resolved. Bound only the
        // transient notification queue.
        toasts: next.filter((candidate) => {
          if (candidate.manualDismissOnly || candidate.pinned || transientToEvict === 0) return true;
          transientToEvict -= 1;
          return false;
        }),
      };
    });
    return id;
  },

  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),

  markExiting: (id) =>
    set((state) => ({
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, exiting: true } : t)),
    })),

  disableAutoDismiss: (id) =>
    set((state) => ({
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, exiting: false, manualDismissOnly: true } : t)),
    })),
}));
