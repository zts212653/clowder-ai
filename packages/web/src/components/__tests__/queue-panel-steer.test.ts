/**
 * F047: QueuePanel steer UI
 * - QueuePanel renders only durable pending entries
 * - Steer modal offers interrupting restart and non-interrupting delivery
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { QueuePanel } from '../QueuePanel';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => {
    const cats = [
      {
        id: 'opus',
        displayName: '布偶猫',
        avatar: '/opus.png',
        roster: { available: true },
        isDefaultResponder: true,
        messageDeliveryCapabilities: { guideReply: true },
      },
      {
        id: 'codex',
        displayName: '缅因猫',
        avatar: '/codex.png',
        roster: { available: true },
        messageDeliveryCapabilities: { guideReply: false },
      },
    ];
    return {
      cats,
      getCatById: (catId: string) => cats.find((cat) => cat.id === catId),
    };
  },
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const NOW = Date.now();

const QUEUED_ENTRY: QueueEntry = {
  id: 'q1',
  threadId: 'thread-1',
  userId: 'u1',
  content: 'queued message',
  messageId: 'm1',
  mergedMessageIds: [],
  from: { kind: 'user', userId: 'test-user' },
  targetCats: ['opus'],
  intent: 'execute',
  status: 'queued',
  createdAt: NOW,
};

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function defaultApiFetch(path: string, init?: RequestInit) {
  if (path.endsWith('/cats')) {
    return response({
      fallbackTargetCatId: 'opus',
      participants: [
        { catId: 'opus', lastMessageAt: 2, lastResponseHealthy: true },
        { catId: 'codex', lastMessageAt: 1, lastResponseHealthy: true },
      ],
    });
  }
  if (path.endsWith('/targets')) {
    if (init?.method !== 'POST') {
      return response({
        sourceRecordId: 'm1',
        targets: [{ targetCatId: 'opus', state: 'pending', actionable: true }],
      });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      targets?: Array<{
        targetCatId: string;
        strategy: 'guide_reply' | 'interrupt_reply';
        membershipAtOpen: 'member' | 'admit';
      }>;
    };
    return response({
      targets: (body.targets ?? []).map((target) => ({
        ...target,
        entryId: 'q1',
      })),
    });
  }
  return response({ queue: [] });
}

async function openSteer(container: HTMLDivElement) {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="steer-q1"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
  });
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
    vi.mocked(apiFetch)
      .mockReset()
      .mockImplementation(defaultApiFetch as typeof apiFetch);

    useChatStore.setState({
      messages: [],
      queue: [],
      currentThreadId: 'thread-1',
      activeInvocations: {},
      catInvocations: {},
      targetCats: [],
      threads: [
        {
          id: 'thread-1',
          projectPath: '/test',
          title: 'Test thread',
          createdBy: 'test-user',
          participants: ['opus', 'codex'],
          lastActiveAt: NOW,
          createdAt: NOW,
        },
      ],
    });
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('renders Steer for a durable pending entry', () => {
    useChatStore.setState({ queue: [QUEUED_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const html = container.innerHTML;
    expect(html).toContain('Steer');
  });

  it('renders only pending targets and no Queue-owned terminal copy', () => {
    useChatStore.setState({
      queue: [
        {
          ...QUEUED_ENTRY,
          targetCats: ['opus', 'codex'],
        },
      ],
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).toContain('opus');
    expect(container.textContent).toContain('codex');
    expect(container.textContent?.match(/未投递 · 排队中/g)).toHaveLength(2);
    expect(container.textContent).not.toContain('处理失败');
    expect(container.textContent).not.toContain('已处理');
  });

  it('submits Steer as immediate cancel-and-restart without a promote choice', async () => {
    const { apiFetch } = await import('@/utils/api-client');
    useChatStore.setState({ queue: [QUEUED_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const steerBtn = container.querySelector('[data-testid="steer-q1"]') as HTMLButtonElement | null;
    expect(steerBtn).not.toBeNull();
    await openSteer(container);

    expect(container.querySelector('[data-testid="steer-mode-promote"]')).toBeNull();

    const confirm = container.querySelector('[data-testid="steer-confirm"]') as HTMLButtonElement | null;
    expect(confirm).not.toBeNull();
    expect(confirm?.disabled).toBe(false);
    expect(container.querySelector('[data-testid="steer-interrupt-reply"]')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      confirm?.click();
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/threads/thread-1/queue/q1/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceRecordId: 'm1',
        observedPendingTargetIds: ['opus'],
        targets: [{ targetCatId: 'opus', strategy: 'interrupt_reply', membershipAtOpen: 'member' }],
      }),
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/threads/thread-1/queue/q1/steer',
      expect.objectContaining({ body: JSON.stringify({ targetCatId: 'opus' }) }),
    );
  });

  it('lets a targetless queued message select an exact current-thread member', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path.endsWith('/targets') && init?.method !== 'POST') {
        return response({ sourceRecordId: 'm1', targets: [] }) as Response;
      }
      return defaultApiFetch(path, init) as Promise<Response>;
    });
    useChatStore.setState({ queue: [{ ...QUEUED_ENTRY, targetCats: [] }] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    await openSteer(container);
    expect(container.querySelector('[data-testid="steer-target-opus"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="steer-target-codex"]')).not.toBeNull();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-target-codex"]')?.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-interrupt-reply"]')?.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-target-opus"]')?.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-interrupt-reply"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.click());

    expect(apiFetch).toHaveBeenCalledWith('/api/threads/thread-1/queue/q1/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceRecordId: 'm1',
        observedPendingTargetIds: [],
        targets: [
          { targetCatId: 'opus', strategy: 'interrupt_reply', membershipAtOpen: 'member' },
          { targetCatId: 'codex', strategy: 'interrupt_reply', membershipAtOpen: 'member' },
        ],
      }),
    });
  });

  it('falls back to the configured default responder when a new thread has no members or routing history', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path.endsWith('/cats')) return response({ participants: [], fallbackTargetCatId: 'opus' }) as Response;
      if (path.endsWith('/targets') && init?.method !== 'POST') {
        return response({ sourceRecordId: 'm1', targets: [] }) as Response;
      }
      return defaultApiFetch(path, init) as Promise<Response>;
    });
    useChatStore.setState({
      queue: [{ ...QUEUED_ENTRY, targetCats: [] }],
      threads: [
        {
          id: 'thread-1',
          projectPath: '/test',
          title: 'New thread',
          createdBy: 'test-user',
          participants: [],
          lastActiveAt: NOW,
          createdAt: NOW,
        },
      ],
    });
    act(() => root.render(React.createElement(QueuePanel, { threadId: 'thread-1' })));

    await openSteer(container);

    expect(container.querySelector('[data-testid="steer-target-opus"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-testid="steer-target-codex"]')).toBeNull();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-interrupt-reply"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.click());
    expect(apiFetch).toHaveBeenCalledWith('/api/threads/thread-1/queue/q1/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceRecordId: 'm1',
        observedPendingTargetIds: [],
        targets: [{ targetCatId: 'opus', strategy: 'interrupt_reply', membershipAtOpen: 'admit' }],
      }),
    });
  });

  it('offers Append only from the server projection and echoes both exact fences', async () => {
    const appendEntry: QueueEntry = {
      ...QUEUED_ENTRY,
      lifecycleActions: {
        append: {
          kind: 'append',
          expectedQueueRevision: 'revision-1',
          expectedRuns: [{ targetId: 'opus', invocationId: 'turn-1', responseMessageId: 'response-1' }],
        },
      },
    };
    useChatStore.setState({ queue: [appendEntry] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const append = container.querySelector('[data-testid="append-q1"]') as HTMLButtonElement | null;
    expect(append).not.toBeNull();
    await act(async () => append?.click());

    expect(apiFetch).toHaveBeenCalledWith('/api/threads/thread-1/queue/q1/append', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedQueueRevision: 'revision-1',
        expectedRuns: [{ targetId: 'opus', invocationId: 'turn-1', responseMessageId: 'response-1' }],
      }),
    });
    expect(useChatStore.getState().queue).toEqual([]);
  });

  it('never infers Append from a local active invocation without a server action', () => {
    useChatStore.setState({
      queue: [QUEUED_ENTRY],
      activeInvocations: { 'turn-1': { catId: 'opus', mode: 'execute', startedAt: Date.now() } },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });
    expect(container.querySelector('[data-testid="append-q1"]')).toBeNull();
  });

  it('preserves a concurrent Queue arrival when an Append response resolves from an older render', async () => {
    const appendEntry: QueueEntry = {
      ...QUEUED_ENTRY,
      lifecycleActions: {
        append: {
          kind: 'append',
          expectedQueueRevision: 'revision-1',
          expectedRuns: [{ targetId: 'opus', invocationId: 'turn-1', responseMessageId: 'response-1' }],
        },
      },
    };
    const concurrentEntry: QueueEntry = { ...QUEUED_ENTRY, id: 'q-concurrent', content: 'arrived while appending' };
    let resolveAppend!: (value: Response) => void;
    vi.mocked(apiFetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAppend = resolve;
        }),
    );
    useChatStore.setState({ queue: [appendEntry] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const append = container.querySelector('[data-testid="append-q1"]') as HTMLButtonElement | null;
    await act(async () => {
      append?.click();
      await Promise.resolve();
    });
    act(() => useChatStore.getState().setQueue('thread-1', [appendEntry, concurrentEntry]));
    await act(async () => {
      resolveAppend(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      await Promise.resolve();
    });

    expect(useChatStore.getState().queue).toEqual([concurrentEntry]);
  });

  it('closes a stale Steer confirmation and refreshes Queue truth after a 409', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path.endsWith('/cats')) {
        return response({ participants: [{ catId: 'opus', lastMessageAt: 2, lastResponseHealthy: true }] }) as Response;
      }
      if (path.endsWith('/targets')) {
        if (init?.method !== 'POST') {
          return response({
            sourceRecordId: 'm1',
            targets: [{ targetCatId: 'opus', state: 'pending', actionable: true }],
          }) as Response;
        }
        return response({ code: 'ENTRY_PROCESSING', error: '条目正在处理中，无法 steer' }, 409) as Response;
      }
      return response({ queue: [], paused: false }) as Response;
    });
    useChatStore.setState({ queue: [QUEUED_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    await openSteer(container);
    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]');
    expect(confirm).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-interrupt-reply"]')?.click());
    await act(async () => confirm?.click());

    expect(container.querySelector('[data-testid="steer-confirm"]')).toBeNull();
    expect(apiFetch).toHaveBeenCalledWith('/api/threads/thread-1/queue/q1/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceRecordId: 'm1',
        observedPendingTargetIds: ['opus'],
        targets: [{ targetCatId: 'opus', strategy: 'interrupt_reply', membershipAtOpen: 'member' }],
      }),
    });
    expect(apiFetch).toHaveBeenCalledWith('/api/threads/thread-1/queue');
    expect(useChatStore.getState().queue).toEqual([]);
  });

  it('treats a follow-up action that loses to ordinary drain as converged', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path.endsWith('/cats')) {
        return response({
          fallbackTargetCatId: 'opus',
          participants: [{ catId: 'opus', lastMessageAt: 2, lastResponseHealthy: true }],
        }) as Response;
      }
      if (path.endsWith('/targets')) {
        if (init?.method !== 'POST') {
          return response({
            sourceRecordId: 'm1',
            targets: [{ targetCatId: 'opus', state: 'pending', actionable: true }],
          }) as Response;
        }
        return response({
          targets: [{ targetCatId: 'opus', strategy: 'interrupt_reply', entryId: 'q1' }],
        }) as Response;
      }
      if (path.endsWith('/queue/q1/steer')) {
        return response({ code: 'ENTRY_PROCESSING', error: '条目正在处理中' }, 409) as Response;
      }
      return response({ queue: [], paused: false }) as Response;
    });
    useChatStore.setState({ queue: [QUEUED_ENTRY] });
    act(() => root.render(React.createElement(QueuePanel, { threadId: 'thread-1' })));

    await openSteer(container);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-interrupt-reply"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.click());

    expect(container.querySelector('[data-testid="steer-confirm"]')).toBeNull();
    expect(useChatStore.getState().queue).toEqual([]);
    expect(useToastStore.getState().toasts.some((toast) => toast.title === '部分 Steer 未完成')).toBe(false);
  });

  it('keeps Steer available for an ordinary pending target', () => {
    useChatStore.setState({ queue: [QUEUED_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.querySelector('[data-testid="steer-q1"]')).not.toBeNull();
  });

  it('offers guide and interrupt with exact per-member capability', async () => {
    useChatStore.setState({
      queue: [
        {
          ...QUEUED_ENTRY,
          lifecycleActions: {
            append: {
              kind: 'append',
              expectedQueueRevision: 'revision-1',
              expectedRuns: [{ targetId: 'opus', invocationId: 'turn-1', responseMessageId: 'response-1' }],
            },
          },
        },
      ],
      activeInvocations: { 'turn-1': { catId: 'opus', mode: 'execute', startedAt: Date.now() } },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const steerBtn = container.querySelector('[data-testid="steer-q1"]') as HTMLButtonElement | null;
    expect(steerBtn).not.toBeNull();
    await openSteer(container);

    expect(container.textContent).toContain('布偶猫');
    expect(container.querySelector('[data-testid="steer-guide-reply"]')?.textContent).toBe('立即发送，引导回复');
    expect(container.querySelector('[data-testid="steer-interrupt-reply"]')?.textContent).toBe('立即发送，中断回复');
    expect(container.textContent).not.toContain('旧回复会被停止');
    expect(container.textContent).not.toContain('提到队首');

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-guide-reply"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.click());
    expect(apiFetch).toHaveBeenCalledWith('/api/threads/thread-1/queue/q1/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetCatId: 'opus' }),
    });
  });

  it('preserves per-target disposition inside one source Queue row', async () => {
    const entry: QueueEntry = {
      ...QUEUED_ENTRY,
      targetCats: ['opus', 'codex'],
      authorIntentByTarget: {
        opus: { requested: 'next_work', effective: 'next_work' },
        codex: { requested: 'continue_current', effective: 'next_work' },
      },
    };
    useChatStore.setState({
      queue: [entry],
      activeInvocations: {
        'turn-opus': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
        'turn-codex': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
      },
    });
    act(() => root.render(React.createElement(QueuePanel, { threadId: 'thread-1' })));

    await openSteer(container);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-target-codex"]')?.click());

    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="steer-interrupt-reply"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('shows History-delivered targets as non-actionable while leaving the pending target selected', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path.endsWith('/cats')) {
        return response({
          fallbackTargetCatId: 'opus',
          participants: [
            { catId: 'opus', lastMessageAt: 2 },
            { catId: 'codex', lastMessageAt: 1 },
          ],
        }) as Response;
      }
      if (path.endsWith('/targets') && init?.method !== 'POST') {
        return response({
          sourceRecordId: 'm1',
          targets: [
            { targetCatId: 'opus', state: 'settled', actionable: false, dispatchedAt: 10 },
            { targetCatId: 'codex', state: 'pending', actionable: true },
          ],
        }) as Response;
      }
      return defaultApiFetch(path, init) as Promise<Response>;
    });
    useChatStore.setState({
      queue: [{ ...QUEUED_ENTRY, id: 'q-codex', targetCats: ['codex'] }],
    });
    act(() => root.render(React.createElement(QueuePanel, { threadId: 'thread-1' })));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="steer-q-codex"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const opus = container.querySelector<HTMLButtonElement>('[data-testid="steer-target-opus"]');
    const codex = container.querySelector<HTMLButtonElement>('[data-testid="steer-target-codex"]');
    expect(opus?.disabled).toBe(true);
    expect(opus?.textContent).toContain('已投递');
    expect(codex?.disabled).toBe(false);
    expect(codex?.getAttribute('aria-pressed')).toBe('true');
  });

  it('offers a non-interrupting reminder for an unread target with an active turn', async () => {
    useChatStore.setState({
      queue: [
        {
          ...QUEUED_ENTRY,
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
          authorIntentByTarget: {
            opus: {
              requested: 'next_work',
              effective: 'next_work',
              carrierCapability: {
                provider: 'anthropic',
                carrier: 'claude_print_sdk',
                deliverySemantics: 'unsupported',
              },
            },
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

    expect(container.textContent).toContain('排队等待');
    expect(container.textContent).toContain('当前接入不支持引导回复/提醒');
    expect(container.querySelector('[data-testid="remind-q1-opus"]')).toBeNull();
  });
});
