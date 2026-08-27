/**
 * F047: QueuePanel steer UI
 * - Steer button shows only for queued entries
 * - Steer modal submits the sole cancel-and-restart action
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
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

const FAILED_ENTRY: QueueEntry = {
  ...QUEUED_ENTRY,
  targetStates: { opus: 'failed' },
  queueReceipt: {
    version: 1,
    entryId: QUEUED_ENTRY.id,
    targets: [
      {
        catId: 'opus',
        state: 'failed',
        attempts: [
          {
            id: 'q1:opus:3',
            targetCatId: 'opus',
            sequence: 3,
            state: 'failed',
            createdAt: NOW - 100,
            updatedAt: NOW,
            terminalReason: 'invocation_failed',
          },
        ],
      },
    ],
    reminderAttempts: [],
  },
};

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

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
      activeInvocations: {},
      catInvocations: {},
      targetCats: [],
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

  it('routes a failed target to Retry instead of exposing Steer', () => {
    useChatStore.setState({ queue: [FAILED_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.querySelector('[data-testid="steer-q1"]')).toBeNull();
    expect(container.querySelector('[data-testid="retry-q1-opus"]')).not.toBeNull();
  });

  it('retries the exact failed target once through its message and attempt fence', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(response({ status: 'retry_queued' }, 202) as Response);
    useChatStore.setState({ queue: [FAILED_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const retry = container.querySelector('[data-testid="retry-q1-opus"]') as HTMLButtonElement | null;
    expect(retry).not.toBeNull();
    await act(async () => retry?.click());

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/messages/m1/queue-targets/opus/retry',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ attemptId: 'q1:opus:3' }),
      }),
    );
  });

  it('renders only actionable per-target queue truth hydrated from the server', () => {
    useChatStore.setState({
      queue: [
        {
          ...QUEUED_ENTRY,
          targetCats: ['opus', 'codex'],
          targetStates: { opus: 'seen', codex: 'failed', gpt52: 'handled' },
        },
      ],
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).toContain('已读，但关联回合已结束；尚未确认处理完成');
    expect(container.textContent).toContain('处理失败 · 已回队列');
    expect(container.textContent).not.toContain('已处理 · 无可回溯证据');
  });

  it('submits Steer as immediate cancel-and-restart without a promote choice', async () => {
    const { apiFetch } = await import('@/utils/api-client');
    useChatStore.setState({ queue: [QUEUED_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const steerBtn = container.querySelector('[data-testid="steer-q1"]') as HTMLButtonElement | null;
    expect(steerBtn).not.toBeNull();
    act(() => steerBtn?.click());

    expect(container.querySelector('[data-testid="steer-mode-promote"]')).toBeNull();

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
    expect(callArgs.body).toBeUndefined();
  });

  it('closes a stale Steer confirmation and refreshes Queue truth after a 409', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(
        response({ code: 'STEER_STATE_CHANGED', error: 'Steer 状态已变化，请重试' }, 409) as Response,
      )
      .mockResolvedValueOnce(response({ queue: [], paused: false }) as Response);
    useChatStore.setState({ queue: [{ ...QUEUED_ENTRY, targetStates: { opus: 'queued' } }] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-q1"]')?.click());
    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]');
    expect(confirm).not.toBeNull();
    await act(async () => confirm?.click());

    expect(container.querySelector('[data-testid="steer-confirm"]')).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/threads/thread-1/queue/q1/steer', { method: 'POST' });
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/threads/thread-1/queue');
    expect(useChatStore.getState().queue).toEqual([]);
  });

  it('keeps Steer available for an ordinary pending target', () => {
    useChatStore.setState({ queue: [{ ...QUEUED_ENTRY, targetStates: { opus: 'queued' } }] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.querySelector('[data-testid="steer-q1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="retry-q1-opus"]')).toBeNull();
  });

  it('shows the single Steer contract as stop current then restart from this exact message', () => {
    useChatStore.setState({ queue: [QUEUED_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const steerBtn = container.querySelector('[data-testid="steer-q1"]') as HTMLButtonElement | null;
    expect(steerBtn).not.toBeNull();
    act(() => steerBtn?.click());

    expect(container.textContent).toContain('停止目标当前回复');
    expect(container.textContent).toContain('立即发送这条排队消息');
    expect(container.textContent).toContain('已经完成的回复仍会保留');
    expect(container.querySelector('[data-testid="steer-confirm"]')?.textContent).toBe('停止并发送');
    expect(container.textContent).not.toContain('提到队首');
  });

  it('offers a non-interrupting reminder for an unread target with an active turn', async () => {
    useChatStore.setState({
      queue: [
        {
          ...QUEUED_ENTRY,
          targetStates: { opus: 'queued' },
          queueReceipt: {
            version: 1,
            entryId: 'q1',
            targets: [{ catId: 'opus', state: 'queued' }],
            reminderAttempts: [],
          },
        },
      ],
      activeInvocations: {
        'inv-active': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
      catInvocations: {
        opus: {
          invocationId: 'inv-active',
          freshnessCarrierCapability: {
            provider: 'openai_codex',
            carrier: 'codex_app_server',
            deliverySemantics: 'exact_active_turn',
          },
        },
      },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const remind = container.querySelector('[data-testid="remind-q1-opus"]') as HTMLButtonElement | null;
    expect(remind).not.toBeNull();
    expect(remind?.textContent).toContain('提醒');

    await act(async () => remind?.click());

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/threads/thread-1/queue/q1/remind',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ targetCatId: 'opus' }),
      }),
    );
  });

  it('shows the exact pending reminder state without offering a duplicate click', () => {
    useChatStore.setState({
      queue: [
        {
          ...QUEUED_ENTRY,
          targetStates: { opus: 'notified' },
          queueReceipt: {
            version: 1,
            entryId: 'q1',
            targets: [{ catId: 'opus', state: 'notified' }],
            reminderAttempts: [
              {
                id: 'reminder-1',
                targetCatId: 'opus',
                invocationId: 'inv-active',
                state: 'delivered',
                requestedAt: 1,
                deliveredAt: 2,
              },
            ],
          },
        },
      ],
      activeInvocations: {
        'inv-active': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).toContain('提醒已送达 · 尚未读取');
    expect(container.querySelector('[data-testid="remind-q1-opus"]')).toBeNull();
  });

  it('shows author disposition without opening the body and suppresses reminder on unsupported carriers', () => {
    useChatStore.setState({
      queue: [
        {
          ...QUEUED_ENTRY,
          targetStates: { opus: 'queued' },
          queueReceipt: {
            version: 1,
            entryId: 'q1',
            targets: [
              {
                catId: 'opus',
                state: 'queued',
                authorIntent: {
                  requested: 'next_work',
                  effective: 'next_work',
                  carrierCapability: {
                    provider: 'anthropic',
                    carrier: 'claude_print_sdk',
                    deliverySemantics: 'unsupported',
                  },
                },
              },
            ],
            reminderAttempts: [],
          },
        },
      ],
      activeInvocations: {
        'inv-active': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
      catInvocations: {
        opus: {
          invocationId: 'inv-active',
          freshnessCarrierCapability: {
            provider: 'anthropic',
            carrier: 'claude_print_sdk',
            deliverySemantics: 'unsupported',
          },
        },
      },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).toContain('下一件工作');
    expect(container.textContent).toContain('当前接入不支持本轮读取/提醒');
    expect(container.querySelector('[data-testid="remind-q1-opus"]')).toBeNull();
  });
});
