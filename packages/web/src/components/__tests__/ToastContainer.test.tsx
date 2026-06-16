/**
 * #924 regression test — ToastContainer thread-scoped filtering.
 *
 * ToastContainer now reads currentThreadId from chatStore and filters toasts:
 * - Global toasts (no threadId) always show.
 * - Thread-scoped toasts only show when the matching thread is active.
 *
 * Uses renderToStaticMarkup to avoid the act() production-build limitation
 * while still exercising the real component's filter logic.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ToastItem } from '@/stores/toastStore';

// ── Mock state ──
let mockCurrentThreadId = 'thread-A';
let mockToasts: ToastItem[] = [];

vi.mock('@/stores/chatStore', () => {
  const getState = () => ({ currentThreadId: mockCurrentThreadId });
  const useChatStore = ((selector?: (state: ReturnType<typeof getState>) => unknown) =>
    selector ? selector(getState()) : getState()) as {
    (selector?: (state: ReturnType<typeof getState>) => unknown): unknown;
    getState: typeof getState;
  };
  useChatStore.getState = getState;
  return { useChatStore };
});

vi.mock('@/stores/toastStore', () => {
  const getState = () => ({
    toasts: mockToasts,
    removeToast: vi.fn(),
    markExiting: vi.fn(),
  });
  const useToastStore = ((selector?: (state: ReturnType<typeof getState>) => unknown) =>
    selector ? selector(getState()) : getState()) as {
    (selector?: (state: ReturnType<typeof getState>) => unknown): unknown;
    getState: typeof getState;
  };
  useToastStore.getState = getState;
  return { useToastStore };
});

import { getHiddenToastExpiries, ToastContainer } from '../ToastContainer';

function makeToast(overrides: Partial<ToastItem> & { id: string }): ToastItem {
  return {
    type: 'info',
    title: `Toast ${overrides.id}`,
    message: `Message for ${overrides.id}`,
    duration: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

function renderContainer(): string {
  return renderToStaticMarkup(React.createElement(ToastContainer));
}

describe('ToastContainer thread-scoped filtering (#924)', () => {
  it('renders nothing when there are no toasts', () => {
    mockToasts = [];
    mockCurrentThreadId = 'thread-A';
    const html = renderContainer();
    expect(html).toBe('');
  });

  it('shows global toasts (no threadId) regardless of active thread', () => {
    mockCurrentThreadId = 'thread-A';
    mockToasts = [
      makeToast({ id: 'global-1', title: 'Global notice' }),
      makeToast({ id: 'global-2', title: 'Another global' }),
    ];

    const html = renderContainer();
    expect(html).toContain('Global notice');
    expect(html).toContain('Another global');
  });

  it('shows thread-scoped toasts when the matching thread is active', () => {
    mockCurrentThreadId = 'thread-A';
    mockToasts = [makeToast({ id: 'scoped-1', title: 'Thread A toast', threadId: 'thread-A' })];

    const html = renderContainer();
    expect(html).toContain('Thread A toast');
  });

  it('hides thread-scoped toasts when a different thread is active', () => {
    mockCurrentThreadId = 'thread-B';
    mockToasts = [makeToast({ id: 'scoped-1', title: 'Thread A toast', threadId: 'thread-A' })];

    const html = renderContainer();
    // Thread-A toast must not appear while thread-B is active
    expect(html).not.toContain('Thread A toast');
    // Container returns null when no visible toasts → empty string
    expect(html).toBe('');
  });

  it('shows global + matching thread toasts, hides non-matching', () => {
    mockCurrentThreadId = 'thread-A';
    mockToasts = [
      makeToast({ id: 'global-1', title: 'Global notice' }),
      makeToast({ id: 'scoped-a', title: 'For thread A', threadId: 'thread-A' }),
      makeToast({ id: 'scoped-b', title: 'For thread B', threadId: 'thread-B' }),
    ];

    const html = renderContainer();
    expect(html).toContain('Global notice');
    expect(html).toContain('For thread A');
    expect(html).not.toContain('For thread B');

    // Exactly 2 role="alert" elements (global + thread-A)
    const alertCount = (html.match(/role="alert"/g) || []).length;
    expect(alertCount).toBe(2);
  });

  it('getHiddenToastExpiries identifies expired hidden toasts', () => {
    const now = 10000;
    const toasts = [
      makeToast({ id: 'hidden-expired', threadId: 'thread-A', duration: 3000, createdAt: now - 5000 }),
      makeToast({ id: 'hidden-alive', threadId: 'thread-A', duration: 8000, createdAt: now - 2000 }),
      makeToast({ id: 'visible', threadId: 'thread-B', duration: 3000, createdAt: now - 5000 }),
      makeToast({ id: 'global', duration: 3000, createdAt: now - 5000 }),
    ];
    const result = getHiddenToastExpiries(toasts, 'thread-B', now);
    expect(result.expired).toEqual(['hidden-expired']);
    // Next expiry = 8000 - 2000 = 6000ms
    expect(result.nextMs).toBe(6000);
  });

  it('getHiddenToastExpiries returns null nextMs when no pending hidden toasts', () => {
    const now = 10000;
    const toasts = [
      makeToast({ id: 'visible', threadId: 'thread-A', duration: 3000, createdAt: now - 1000 }),
      makeToast({ id: 'global', duration: 5000, createdAt: now - 1000 }),
    ];
    const result = getHiddenToastExpiries(toasts, 'thread-A', now);
    expect(result.expired).toEqual([]);
    expect(result.nextMs).toBeNull();
  });

  it('updates visibility when the active thread changes', () => {
    mockToasts = [
      makeToast({ id: 'scoped-a', title: 'For thread A', threadId: 'thread-A' }),
      makeToast({ id: 'scoped-b', title: 'For thread B', threadId: 'thread-B' }),
    ];

    // Thread A active
    mockCurrentThreadId = 'thread-A';
    const htmlA = renderContainer();
    expect(htmlA).toContain('For thread A');
    expect(htmlA).not.toContain('For thread B');

    // Switch to thread B
    mockCurrentThreadId = 'thread-B';
    const htmlB = renderContainer();
    expect(htmlB).not.toContain('For thread A');
    expect(htmlB).toContain('For thread B');
  });
});
