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

    expect(container.textContent).toContain('opus · 已读，但关联回合已结束；尚未确认处理完成');
    expect(container.textContent).toContain('codex · 处理失败 · 已回队列');
    expect(container.textContent).not.toContain('gpt52 · 已处理');
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

  it('shows the single Steer contract as cancel current then restart from this exact message', () => {
    useChatStore.setState({ queue: [QUEUED_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const steerBtn = container.querySelector('[data-testid="steer-q1"]') as HTMLButtonElement | null;
    expect(steerBtn).not.toBeNull();
    act(() => steerBtn?.click());

    expect(container.textContent).toContain('取消当前回合');
    expect(container.textContent).toContain('以这条消息立即重新启动');
    expect(container.textContent).toContain('取消前已经完成的回复仍会发表');
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
    expect(remind?.textContent).toContain('提醒猫');

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

    expect(container.textContent).toContain('下一件工作 · 本轮不可见');
    expect(container.textContent).toContain('当前接入不支持本轮提醒');
    expect(container.querySelector('[data-testid="remind-q1-opus"]')).toBeNull();
  });
});
