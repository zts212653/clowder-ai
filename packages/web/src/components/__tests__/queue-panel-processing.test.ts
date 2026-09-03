/**
 * QueuePanel: processing entries should NOT be visible
 * (processing = already executing, user sees it in chat area)
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
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
  id: 'q-proc',
  content: 'processing message',
  status: 'processing',
};

function withTargetStates(
  targetStates: NonNullable<QueueEntry['targetStates']>,
  targetCats = Object.keys(targetStates),
): QueueEntry {
  return {
    ...QUEUED_ENTRY,
    targetCats,
    targetStates,
    queueReceipt: {
      version: 1,
      entryId: QUEUED_ENTRY.id,
      targets: Object.entries(targetStates).map(([catId, state]) => ({
        catId,
        state,
        ...(state === 'seen'
          ? { invocationId: `inv-${catId}`, seenAt: NOW - 1_000 }
          : state === 'awakened'
            ? { invocationId: `inv-${catId}`, awakenedAt: NOW - 1_500 }
            : {}),
      })),
      reminderAttempts: [],
    },
  };
}

describe('QueuePanel hides processing entries', () => {
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
      activeInvocations: {},
      catInvocations: {},
      currentThreadId: 'thread-1',
    });
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('does NOT render processing-only queue', () => {
    useChatStore.setState({ queue: [PROCESSING_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    // Processing entry should not be visible — panel should be empty/hidden
    expect(container.innerHTML).not.toContain('processing message');
  });

  it('renders queued entries but hides processing entries', () => {
    useChatStore.setState({ queue: [PROCESSING_ENTRY, QUEUED_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const html = container.innerHTML;
    // Only queued entry visible
    expect(html).toContain('queued message');
    expect(html).not.toContain('processing message');
    // Steer button for queued entry
    expect(container.querySelector('[data-testid="steer-q1"]')).not.toBeNull();
  });

  it('offers an explicit recovery action when queued work has no active blocker', async () => {
    const { apiFetch } = await import('@/utils/api-client');
    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true, json: async () => ({ started: true }) } as Response);
    useChatStore.setState({ queue: [QUEUED_ENTRY], queuePaused: false, activeInvocations: {} });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const recovery = container.querySelector('[data-testid="queue-recover"]') as HTMLButtonElement | null;
    expect(recovery).not.toBeNull();
    expect(recovery?.textContent).toContain('恢复');

    await act(async () => recovery?.click());
    expect(apiFetch).toHaveBeenCalledWith('/api/threads/thread-1/queue/next', { method: 'POST' });
  });

  it('does not offer recovery while the queued target still has an active blocker', () => {
    useChatStore.setState({
      queue: [QUEUED_ENTRY],
      queuePaused: false,
      activeInvocations: {
        'inv-active': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.querySelector('[data-testid="queue-recover"]')).toBeNull();
  });

  it('moves a seen child target out of the queue when its parent control slot is live', () => {
    useChatStore.setState({
      queue: [withTargetStates({ opus: 'seen' })],
      queuePaused: false,
      activeInvocations: {
        'parent-opus': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
      catInvocations: {
        opus: {
          invocationId: 'parent-opus',
          turnInvocationId: 'inv-opus',
          startedAt: Date.now(),
        },
      },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).not.toContain('待处理');
    expect(container.textContent).not.toContain('当前轮处理中');
    expect(container.querySelector('[data-testid="steer-q1"]')).toBeNull();
  });

  it('liveness-first: keeps an agent/A2A exact receipt out of QueuePanel when its child live turn is already bridged', () => {
    useChatStore.setState({
      queuePaused: false,
      activeInvocations: {
        'parent-opus': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
      catInvocations: {
        opus: {
          invocationId: 'parent-opus',
          turnInvocationId: 'inv-opus',
          startedAt: Date.now(),
        },
      },
    });
    useChatStore.getState().setQueue('thread-1', [
      {
        ...withTargetStates({ opus: 'seen' }),
        id: 'q-agent-live',
        source: 'agent',
        sourceCategory: 'a2a',
        autoExecute: true,
        callerCatId: 'codex',
      },
    ]);
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).not.toContain('待处理');
    expect(container.textContent).not.toContain('当前轮处理中');
    expect(container.querySelector('[data-testid="steer-q-agent-live"]')).toBeNull();
  });

  it('moves an awakened exact child out of QueuePanel while its parent control slot is live', () => {
    useChatStore.setState({
      queue: [withTargetStates({ opus: 'awakened' })],
      queuePaused: false,
      activeInvocations: {
        'parent-opus': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
      catInvocations: {
        opus: {
          invocationId: 'parent-opus',
          turnInvocationId: 'inv-opus',
          startedAt: Date.now(),
        },
      },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).not.toContain('待处理');
    expect(container.querySelector('[data-testid="steer-q1"]')).toBeNull();
  });

  it('keeps an awakened target visible as recoverable when its exact child is no longer live', () => {
    useChatStore.setState({
      queue: [withTargetStates({ opus: 'awakened' })],
      queuePaused: false,
      activeInvocations: {},
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).toContain('待处理');
    expect(container.textContent).toContain('已唤醒，但关联回合已结束；尚未读取消息正文');
    expect(container.querySelector('[data-testid="queue-recover"]')).not.toBeNull();
  });

  it('keeps a seen target without a live invocation as an explicit recoverable anomaly', () => {
    useChatStore.setState({
      queue: [withTargetStates({ opus: 'seen' })],
      queuePaused: false,
      activeInvocations: {},
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).toContain('待处理');
    expect(container.textContent).toContain('已读，但关联回合已结束；尚未确认处理完成');
    expect(container.textContent).not.toContain('当前轮处理中');
    expect(container.querySelector('[data-testid="queue-recover"]')).not.toBeNull();
  });

  it('does not borrow an unrelated live cat to hide a seen target anomaly', () => {
    useChatStore.setState({
      queue: [withTargetStates({ opus: 'seen' })],
      queuePaused: false,
      activeInvocations: {
        'inv-codex': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
      },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).toContain('已读，但关联回合已结束；尚未确认处理完成');
    expect(container.querySelector('[data-testid="queue-recover"]')).not.toBeNull();
  });

  it('does not borrow a different live invocation for the same cat', () => {
    useChatStore.setState({
      queue: [withTargetStates({ opus: 'seen' })],
      queuePaused: false,
      activeInvocations: {
        'parent-opus-successor': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
      catInvocations: {
        opus: {
          invocationId: 'parent-opus-previous',
          turnInvocationId: 'inv-opus',
          startedAt: Date.now() - 1_000,
        },
      },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).toContain('已读，但关联回合已结束；尚未确认处理完成');
    expect(container.querySelector('[data-testid="queue-recover"]')).not.toBeNull();
  });

  it('does not let a parent-only rebind inherit the previous child receipt', () => {
    useChatStore.setState({
      queue: [withTargetStates({ opus: 'seen' })],
      queuePaused: false,
      activeInvocations: {
        'parent-opus-new': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
      catInvocations: {
        opus: {
          invocationId: 'parent-opus-old',
          turnInvocationId: 'inv-opus',
          startedAt: Date.now() - 1_000,
        },
      },
    });
    useChatStore.getState().setThreadCatInvocation('thread-1', 'opus', {
      invocationId: 'parent-opus-new',
    });

    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).toContain('已读，但关联回合已结束；尚未确认处理完成');
    expect(container.textContent).not.toContain('当前轮处理中');
    expect(container.querySelector('[data-testid="queue-recover"]')).not.toBeNull();
  });

  it('fails closed when a seen target has no exact receipt invocation id', () => {
    useChatStore.setState({
      queue: [
        {
          ...QUEUED_ENTRY,
          id: 'q-agent-missing-exact-id',
          source: 'agent',
          sourceCategory: 'a2a',
          autoExecute: true,
          callerCatId: 'codex',
          targetStates: { opus: 'seen' },
          queueReceipt: {
            version: 1,
            entryId: 'q-agent-missing-exact-id',
            targets: [{ catId: 'opus', state: 'seen' }],
            reminderAttempts: [],
          },
        },
      ],
      queuePaused: false,
      activeInvocations: {
        'inv-opus': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).toContain('已读，但关联回合已结束；尚未确认处理完成');
    expect(container.querySelector('[data-testid="queue-recover"]')).not.toBeNull();
  });

  it('counts only actionable targets in a mixed receipt and omits handled evidence', () => {
    useChatStore.setState({
      queue: [withTargetStates({ opus: 'seen', codex: 'queued', gpt52: 'handled' })],
      queuePaused: false,
      activeInvocations: {
        'parent-opus': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
      catInvocations: {
        opus: {
          invocationId: 'parent-opus',
          turnInvocationId: 'inv-opus',
          startedAt: Date.now(),
        },
      },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).toContain('待处理');
    expect(container.textContent).toContain('未读 · 排队中');
    expect(container.textContent).not.toContain('已读，但关联回合已结束');
    expect(container.textContent).not.toContain('已处理 · 无可回溯证据');
    expect(container.textContent).not.toContain('等待 opus 当前回合');
  });

  it('keeps handled-only entries in history rather than the queue panel', () => {
    useChatStore.setState({
      queue: [withTargetStates({ gpt52: 'handled' })],
      queuePaused: false,
      activeInvocations: {},
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).not.toContain('待处理');
    expect(container.textContent).not.toContain('已处理 · 无可回溯证据');
  });

  it('keeps author-withdrawn entries in history rather than the queue panel', () => {
    useChatStore.setState({
      queue: [withTargetStates({ opus: 'withdrawn' })],
      queuePaused: false,
      activeInvocations: {},
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).not.toContain('待处理');
    expect(container.querySelector('[data-testid="steer-q1"]')).toBeNull();
    expect(container.querySelector('[data-testid="queue-recover"]')).toBeNull();
  });

  it('refreshes Queue truth when recovery loses a race without inventing a busy or Steer reason', async () => {
    const { apiFetch } = await import('@/utils/api-client');
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ started: false }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ queue: [], paused: false }) } as Response);
    useChatStore.setState({ queue: [QUEUED_ENTRY], queuePaused: false, activeInvocations: {} });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const recovery = container.querySelector('[data-testid="queue-recover"]') as HTMLButtonElement;
    await act(async () => recovery.click());

    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/threads/thread-1/queue');
    expect(useChatStore.getState().queue).toEqual([]);
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.title).toBe('队列状态已刷新');
    expect(toast?.message).not.toContain('运行占用');
    expect(toast?.message).not.toContain('Steer');
  });

  it('hydrates no-start liveness so exact-live work leaves QueuePanel and ordinary work stops looking orphaned', async () => {
    const { apiFetch } = await import('@/utils/api-client');
    const exactSeenEntry = {
      ...withTargetStates({ opus: 'seen' }),
      id: 'q-exact-seen',
      content: 'exact seen work',
    };
    const ordinaryEntry = {
      ...QUEUED_ENTRY,
      id: 'q-ordinary',
      content: 'ordinary queued work',
    };
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ started: false }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          queue: [exactSeenEntry, ordinaryEntry],
          paused: false,
          activeInvocations: [
            {
              catId: 'opus',
              startedAt: NOW,
              executionId: 'parent-opus',
              turnInvocationId: 'inv-opus',
            },
          ],
        }),
      } as Response);
    useChatStore.setState({
      queue: [exactSeenEntry, ordinaryEntry],
      queuePaused: false,
      activeInvocations: {},
      catInvocations: {},
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const recovery = container.querySelector('[data-testid="queue-recover"]') as HTMLButtonElement;
    expect(recovery).not.toBeNull();
    await act(async () => recovery.click());

    expect(useChatStore.getState().activeInvocations).toHaveProperty('parent-opus');
    expect(useChatStore.getState().catInvocations.opus).toMatchObject({
      invocationId: 'parent-opus',
      turnInvocationId: 'inv-opus',
    });
    expect(container.textContent).not.toContain('exact seen work');
    expect(container.querySelector('[data-testid="steer-q-exact-seen"]')).toBeNull();
    expect(container.textContent).toContain('ordinary queued work');
    expect(container.querySelector('[data-testid="queue-recover"]')).toBeNull();
    expect(container.textContent).not.toContain('等待 opus 调度');
    expect(container.textContent).toContain('等待 opus 当前回合');
  });
});
