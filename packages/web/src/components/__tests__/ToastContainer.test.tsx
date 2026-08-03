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

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToastItem } from '@/stores/toastStore';

// ── Mock state ──
let mockCurrentThreadId = 'thread-A';
let mockToasts: ToastItem[] = [];
const removeToast = vi.fn();
const markExiting = vi.fn();
const disableAutoDismiss = vi.fn();

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
    removeToast,
    markExiting,
    disableAutoDismiss,
  });
  const useToastStore = ((selector?: (state: ReturnType<typeof getState>) => unknown) =>
    selector ? selector(getState()) : getState()) as {
    (selector?: (state: ReturnType<typeof getState>) => unknown): unknown;
    getState: typeof getState;
  };
  useToastStore.getState = getState;
  return { useToastStore };
});

import { getHiddenToastExpiries, ToastCard, ToastContainer } from '../ToastContainer';

const resizeCallbacks = new Set<ResizeObserverCallback>();

class MockResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.add(callback);
  }
  disconnect() {}
  observe() {}
  unobserve() {}
}

function setOverflow(element: Element) {
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: 40 });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 160 });
}

async function notifyResize(element: Element) {
  await act(async () => {
    for (const callback of resizeCallbacks) {
      callback([{ target: element } as ResizeObserverEntry], {} as ResizeObserver);
    }
  });
}

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
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver = MockResizeObserver;
  });

  afterEach(() => {
    resizeCallbacks.clear();
    removeToast.mockReset();
    markExiting.mockReset();
    disableAutoDismiss.mockReset();
    vi.useRealTimers();
  });

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

  it('keeps a short success toast visually quiet without nested recovery chrome', () => {
    const title = '砚砚处理完成';
    const message = '已完成本轮代码检查';
    mockCurrentThreadId = 'thread-A';
    mockToasts = [makeToast({ id: 'success-short', type: 'success', title, message })];

    const holder = document.createElement('div');
    holder.innerHTML = renderContainer();
    const content = holder.querySelector<HTMLElement>('[data-testid="toast-content"]');

    expect(content?.textContent).toContain(title);
    expect(content?.textContent).toContain(message);
    expect(content?.querySelector('[data-overflow-measure="block"]')).not.toBeNull();
    expect(content?.querySelector('[data-critical-text-appearance]')).toBeNull();
    expect(content?.querySelector('button')).toBeNull();
  });

  it('retains an overflowing toast, preserves reader focus, and distinguishes same-title controls', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const first = makeToast({
      id: 'long-a',
      title: '砚砚处理完成',
      message: '第一条包含完整日志的长通知',
      duration: 5_000,
      createdAt: Date.now(),
    });
    const second = makeToast({
      id: 'long-b',
      title: '砚砚处理完成',
      message: '第二条包含完整审阅结论的长通知',
      duration: 5_000,
      createdAt: Date.now(),
    });

    await act(async () => {
      root.render(
        <>
          <ToastCard toast={first} stackPosition={1} stackSize={2} />
          <ToastCard toast={second} stackPosition={2} stackSize={2} />
        </>,
      );
    });
    const summaries = Array.from(container.querySelectorAll('[data-overflow-measure="block"]'));
    for (const summary of summaries) setOverflow(summary);
    for (const summary of summaries) await notifyResize(summary);

    const firstTrigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="查看“砚砚处理完成”通知全文，第 1 条，共 2 条"]',
    );
    const secondTrigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="查看“砚砚处理完成”通知全文，第 2 条，共 2 条"]',
    );
    expect(firstTrigger).not.toBeNull();
    expect(secondTrigger).not.toBeNull();
    expect(container.querySelector('button[aria-label="关闭“砚砚处理完成”通知，第 1 条，共 2 条"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="关闭“砚砚处理完成”通知，第 2 条，共 2 条"]')).not.toBeNull();

    await act(async () => firstTrigger?.click());
    expect(disableAutoDismiss).toHaveBeenCalledWith(first.id);
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(first.message);
    const copyButton = document.body.querySelector<HTMLButtonElement>('button[aria-label="复制完整内容"]');
    copyButton?.focus();
    expect(document.activeElement).toBe(copyButton);

    const third = makeToast({
      id: 'long-c',
      title: '新增通知',
      message: '无关的通知更新',
      duration: 5_000,
      createdAt: Date.now(),
    });
    await act(async () => {
      root.render(
        <>
          <ToastCard toast={first} stackPosition={1} stackSize={3} />
          <ToastCard toast={second} stackPosition={2} stackSize={3} />
          <ToastCard toast={third} stackPosition={3} stackSize={3} />
        </>,
      );
    });
    expect(document.activeElement).toBe(copyButton);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(removeToast).not.toHaveBeenCalledWith(first.id);
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(first.message);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.activeElement).toBe(firstTrigger);
    expect(removeToast).not.toHaveBeenCalledWith(first.id);

    await act(async () => root.unmount());
    container.remove();
  });

  it('cancels pending removal when the reader opens during the exit animation', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const toast = makeToast({
      id: 'exit-race',
      title: '构建完成',
      message: '包含完整构建日志的长通知',
      duration: 50,
      createdAt: Date.now(),
    });

    await act(async () => {
      root.render(<ToastCard toast={toast} />);
    });
    const summary = container.querySelector('[data-overflow-measure="block"]');
    expect(summary).not.toBeNull();
    if (summary) {
      setOverflow(summary);
      await notifyResize(summary);
    }
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    expect(trigger).not.toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(markExiting).toHaveBeenCalledWith(toast.id);

    await act(async () => trigger?.click());
    expect(disableAutoDismiss).toHaveBeenCalledWith(toast.id);

    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(removeToast).not.toHaveBeenCalledWith(toast.id);

    await act(async () => root.unmount());
    container.remove();
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

  it('does not expire a hidden toast once its reader made it manual-dismiss only', () => {
    const now = 10000;
    const retained = makeToast({
      id: 'hidden-retained',
      threadId: 'thread-A',
      duration: 3000,
      createdAt: now - 5000,
      manualDismissOnly: true,
    });

    const result = getHiddenToastExpiries([retained], 'thread-B', now);

    expect(result.expired).toEqual([]);
    expect(result.nextMs).toBeNull();
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
