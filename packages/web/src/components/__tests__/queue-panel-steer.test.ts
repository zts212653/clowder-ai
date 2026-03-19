/**
 * F047: QueuePanel steer UI
 * - Steer button shows only for queued entries
 * - Steer modal submits correct mode
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { QueuePanel } from '../QueuePanel';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));

const NOW = Date.now();

const QUEUED_ENTRY: QueueEntry = {
  id: 'q1',
  threadId: 'thread-1',
  userId: 'u1',
  content: 'queued message',
  messageId: 'm1',
  mergedMessageIds: [],
  source: 'user',
  targetCats: ['opus'],
  intent: 'execute',
  status: 'queued',
  createdAt: NOW,
};

const PROCESSING_ENTRY: QueueEntry = {
  ...QUEUED_ENTRY,
  id: 'q2',
  content: 'processing message',
  status: 'processing',
};

describe('QueuePanel steer (F047)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    useChatStore.setState({
      messages: [],
      queue: [],
      queuePaused: false,
      currentThreadId: 'thread-1',
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('renders Steer only for queued entries', () => {
    useChatStore.setState({ queue: [QUEUED_ENTRY, PROCESSING_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const html = container.innerHTML;
    expect(html).toContain('Steer');
    expect(container.querySelector('[data-testid="steer-q2"]')).toBeNull();
  });

  it('submits steer mode=promote', async () => {
    const { apiFetch } = await import('@/utils/api-client');
    useChatStore.setState({ queue: [QUEUED_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const steerBtn = container.querySelector('[data-testid="steer-q1"]') as HTMLButtonElement | null;
    expect(steerBtn).not.toBeNull();
    act(() => steerBtn?.click());

    const promote = container.querySelector('[data-testid="steer-mode-promote"]') as HTMLButtonElement | null;
    expect(promote).not.toBeNull();
    act(() => promote?.click());

    const confirm = container.querySelector('[data-testid="steer-confirm"]') as HTMLButtonElement | null;
    expect(confirm).not.toBeNull();

    await act(async () => {
      confirm?.click();
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/threads/thread-1/queue/q1/steer',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    const callArgs = (apiFetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as { body?: string };
    expect(callArgs.body).toContain('"mode":"promote"');
  });

  it('shows conditional copy for immediate steer (only interrupts when target cat is busy)', () => {
    useChatStore.setState({ queue: [QUEUED_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const steerBtn = container.querySelector('[data-testid="steer-q1"]') as HTMLButtonElement | null;
    expect(steerBtn).not.toBeNull();
    act(() => steerBtn?.click());

    expect(container.textContent).toContain('立即执行（必要时中断目标猫）');
    expect(container.textContent).toContain('若目标猫正在执行，会先 cancel 该猫当前 invocation');
    expect(container.textContent).not.toContain('会先 cancel 当前 invocation');
  });
});
