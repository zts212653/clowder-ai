import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ThreadState } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

function HookHost({ threadId }: { threadId: string }) {
  useChatHistory(threadId);
  return null;
}

function makeThreadBState(cachedAssistantTs: number, overrides?: Partial<ReturnType<typeof buildThreadBState>>) {
  return {
    ...buildThreadBState(cachedAssistantTs),
    ...overrides,
  };
}

function buildThreadBState(cachedAssistantTs: number) {
  return {
    messages: [
      {
        id: 'b1',
        type: 'assistant' as const,
        catId: 'opus',
        content: 'cached assistant',
        timestamp: cachedAssistantTs,
      },
    ],
    isLoading: true,
    isLoadingHistory: false,
    hasMore: true,
    hasActiveInvocation: true,
    activeInvocations: {},
    intentMode: 'execute' as const,
    targetCats: ['opus'],
    catStatuses: { opus: 'streaming' as const },
    catInvocations: {},
    currentGame: null,

    unreadCount: 0,
    hasUserMention: false,
    lastActivity: cachedAssistantTs,
    queue: [],
    queuePaused: false,
    queuePauseReason: undefined,
    queueFull: false,
    queueFullSource: undefined,
    workspaceWorktreeId: null,
    workspaceOpenTabs: [],
    workspaceOpenFilePath: null,
    workspaceOpenFileLine: null,
  };
}

describe('useChatHistory replace hydration', () => {
  let container: HTMLDivElement;
  let root: Root;
  let revokeSpy: ReturnType<typeof vi.spyOn>;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    if (!globalThis.URL.revokeObjectURL) {
      Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
        writable: true,
        value: vi.fn(),
      });
    }
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    useChatStore.setState({
      messages: [{ id: 'a1', type: 'user', content: 'thread-a message', timestamp: Date.now() - 2000 }],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: true,
      hasActiveInvocation: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      currentGame: null,

      threadStates: {},
      currentThreadId: 'thread-a',
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    revokeSpy.mockRestore();
    apiFetchMock.mockReset();
  });

  function mountReplaceHydrationThread(threadState: ThreadState) {
    useChatStore.setState({
      messages: [{ id: 'a1', type: 'user', content: 'thread-a message', timestamp: Date.now() - 2000 }],
      currentThreadId: 'thread-a',
      threadStates: { 'thread-b': threadState },
    });

    act(() => {
      root.render(React.createElement(HookHost, { threadId: 'thread-b' }));
    });

    act(() => {
      useChatStore.getState().setCurrentThread('thread-b');
    });
  }

  function installDeferredHistoryResponse() {
    let resolveJson: ((value: unknown) => void) | null = null;
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        new Promise((resolve) => {
          resolveJson = resolve;
        }),
    } as Response);
    return {
      waitUntilPending: async () => {
        await act(async () => {
          await Promise.resolve();
        });
      },
      resolve: async (payload: unknown) => {
        await act(async () => {
          resolveJson?.(payload);
          await Promise.resolve();
        });
      },
      expectPending: () => expect(resolveJson).not.toBeNull(),
    };
  }

  it('preserves a newer live bubble that arrived after thread switch', async () => {
    const history = installDeferredHistoryResponse();
    const cachedAssistantTs = Date.now() - 1000;
    mountReplaceHydrationThread(makeThreadBState(cachedAssistantTs));

    act(() => {
      useChatStore.getState().addMessage({
        id: 'live-1',
        type: 'assistant',
        catId: 'opus',
        content: 'live bubble arrived after switch',
        timestamp: Date.now(),
        isStreaming: true,
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['b1', 'live-1']);
    history.expectPending();

    await history.resolve({
      messages: [{ id: 'b1', catId: 'opus', content: 'cached assistant', timestamp: cachedAssistantTs }],
      hasMore: false,
    });

    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['b1', 'live-1']);
  });

  it('keeps a richer local stream bubble instead of a stale draft duplicate', async () => {
    const history = installDeferredHistoryResponse();
    const cachedAssistantTs = Date.now() - 1000;
    mountReplaceHydrationThread(
      makeThreadBState(cachedAssistantTs, {
        catInvocations: { opus: { invocationId: 'inv-1', startedAt: cachedAssistantTs } },
      }),
    );

    act(() => {
      useChatStore.getState().addMessage({
        id: 'live-1',
        type: 'assistant',
        catId: 'opus',
        content: 'local stream bubble is richer than stale draft',
        timestamp: Date.now(),
        isStreaming: true,
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-1' } },
      });
    });

    await history.waitUntilPending();
    history.expectPending();

    await history.resolve({
      messages: [
        { id: 'b1', catId: 'opus', content: 'cached assistant', timestamp: cachedAssistantTs },
        {
          id: 'draft-inv-1',
          catId: 'opus',
          content: 'stale draft',
          origin: 'stream',
          timestamp: Date.now(),
          isDraft: true,
        },
      ],
      hasMore: false,
    });

    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['b1', 'live-1']);
    expect(useChatStore.getState().messages.find((m) => m.id === 'draft-inv-1')).toBeUndefined();
  });

  it('prefers a richer server stream message over a local placeholder for the same invocation', async () => {
    const history = installDeferredHistoryResponse();
    const cachedAssistantTs = Date.now() - 1000;
    mountReplaceHydrationThread(
      makeThreadBState(cachedAssistantTs, {
        catInvocations: { opus: { invocationId: 'inv-1', startedAt: cachedAssistantTs } },
      }),
    );

    act(() => {
      useChatStore.getState().addMessage({
        id: 'live-1',
        type: 'assistant',
        catId: 'opus',
        content: 'partial local bubble',
        timestamp: Date.now(),
        isStreaming: true,
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-1' } },
      });
    });

    await history.waitUntilPending();
    history.expectPending();

    await history.resolve({
      messages: [
        { id: 'b1', catId: 'opus', content: 'cached assistant', timestamp: cachedAssistantTs },
        {
          id: 'server-1',
          catId: 'opus',
          content: 'server caught up with a richer persisted bubble',
          origin: 'stream',
          timestamp: Date.now(),
          extra: { stream: { invocationId: 'inv-1' } },
        },
      ],
      hasMore: false,
    });

    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['b1', 'server-1']);
    expect(useChatStore.getState().messages.find((m) => m.id === 'live-1')).toBeUndefined();
  });

  it('prefers a formal server callback bubble over a richer local stream bubble for the same invocation', async () => {
    const history = installDeferredHistoryResponse();
    const cachedAssistantTs = Date.now() - 1000;
    mountReplaceHydrationThread(
      makeThreadBState(cachedAssistantTs, {
        catInvocations: { opus: { invocationId: 'inv-1', startedAt: cachedAssistantTs } },
      }),
    );

    act(() => {
      useChatStore.getState().addMessage({
        id: 'live-stream-1',
        type: 'assistant',
        catId: 'opus',
        content: 'local stream bubble is richer than the final callback but should still lose during hydration',
        timestamp: Date.now(),
        isStreaming: true,
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-1' } },
      });
    });

    await history.waitUntilPending();
    history.expectPending();

    await history.resolve({
      messages: [
        { id: 'b1', catId: 'opus', content: 'cached assistant', timestamp: cachedAssistantTs },
        {
          id: 'server-callback-1',
          catId: 'opus',
          content: 'final callback answer',
          origin: 'callback',
          timestamp: Date.now(),
          extra: { stream: { invocationId: 'inv-1' } },
        },
      ],
      hasMore: false,
    });

    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['b1', 'server-callback-1']);
    expect(useChatStore.getState().messages.find((m) => m.id === 'live-stream-1')).toBeUndefined();
    expect(useChatStore.getState().messages.find((m) => m.id === 'server-callback-1')).toEqual(
      expect.objectContaining({
        origin: 'callback',
        content: 'final callback answer',
        extra: { stream: { invocationId: 'inv-1' } },
      }),
    );
  });

  it('preserves local CLI payload when hydration returns the same callback id without tool metadata', async () => {
    const history = installDeferredHistoryResponse();
    const cachedAssistantTs = Date.now() - 1_000;
    const now = Date.now();
    mountReplaceHydrationThread({
      messages: [
        {
          id: 'server-callback-tools-1',
          type: 'assistant',
          catId: 'opus',
          content: 'final callback answer',
          origin: 'callback',
          timestamp: now - 2_000,
          isStreaming: false,
          thinking: 'local thinking that should not disappear',
          toolEvents: [{ id: 'te-local-1', type: 'tool_use', label: 'Read file', timestamp: now - 1_800 }],
          extra: { stream: { invocationId: 'inv-tools-1' } },
        },
      ],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: true,
      hasActiveInvocation: false,
      activeInvocations: {},
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      currentGame: null,
      unreadCount: 1,
      hasUserMention: false,
      lastActivity: cachedAssistantTs,
      queue: [],
      queuePaused: false,
      queuePauseReason: undefined,
      queueFull: false,
      queueFullSource: undefined,
      workspaceWorktreeId: null,
      workspaceOpenTabs: [],
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
    });

    await history.waitUntilPending();
    history.expectPending();

    await history.resolve({
      messages: [
        {
          id: 'server-callback-tools-1',
          catId: 'opus',
          content: 'final callback answer',
          origin: 'callback',
          timestamp: now,
        },
      ],
      hasMore: false,
    });

    expect(useChatStore.getState().messages).toEqual([
      expect.objectContaining({
        id: 'server-callback-tools-1',
        origin: 'callback',
        content: 'final callback answer',
        thinking: 'local thinking that should not disappear',
        extra: { stream: { invocationId: 'inv-tools-1' } },
        toolEvents: [expect.objectContaining({ id: 'te-local-1', type: 'tool_use', label: 'Read file' })],
      }),
    ]);
  });

  it('thread switch rehydrates a cached duplicate invocation pair down to one formal callback bubble', async () => {
    const history = installDeferredHistoryResponse();
    const now = Date.now();
    mountReplaceHydrationThread({
      messages: [
        {
          id: 'stream-e-1',
          type: 'assistant',
          catId: 'opus',
          content: 'partial stream bubble',
          origin: 'stream',
          timestamp: now - 2_000,
          extra: { stream: { invocationId: 'inv-e-1' } },
        },
        {
          id: 'callback-e-1',
          type: 'assistant',
          catId: 'opus',
          content: 'stale callback bubble from cached snapshot',
          origin: 'callback',
          timestamp: now - 1_000,
          extra: { stream: { invocationId: 'inv-e-1' } },
        },
      ],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: true,
      hasActiveInvocation: false,
      activeInvocations: {},
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      currentGame: null,
      unreadCount: 0,
      hasUserMention: false,
      lastActivity: now,
      queue: [],
      queuePaused: false,
      queuePauseReason: undefined,
      queueFull: false,
      queueFullSource: undefined,
      workspaceWorktreeId: null,
      workspaceOpenTabs: [],
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
    });

    await history.waitUntilPending();
    history.expectPending();

    await history.resolve({
      messages: [
        {
          id: 'server-callback-e-1',
          catId: 'opus',
          content: 'authoritative callback bubble',
          origin: 'callback',
          timestamp: now,
          extra: { stream: { invocationId: 'inv-e-1' } },
        },
      ],
      hasMore: false,
    });

    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['server-callback-e-1']);
    expect(useChatStore.getState().messages.find((m) => m.id === 'server-callback-e-1')).toEqual(
      expect.objectContaining({
        origin: 'callback',
        content: 'authoritative callback bubble',
        extra: { stream: { invocationId: 'inv-e-1' } },
      }),
    );
  });

  it('reconciles a completed draft bubble with its formal message (Bug B: no duplicate)', async () => {
    const history = installDeferredHistoryResponse();
    const cachedAssistantTs = Date.now() - 1000;
    // No catInvocations — simulates post-done state where invocationId is cleared
    mountReplaceHydrationThread(makeThreadBState(cachedAssistantTs));

    // Simulate: draft bubble loaded on previous F5, now completed (isStreaming=false)
    act(() => {
      useChatStore.getState().addMessage({
        id: 'draft-inv-1',
        type: 'assistant',
        catId: 'codex',
        content: '',
        toolEvents: [{ id: 'te-1', type: 'tool_use' as const, label: 'Read file', timestamp: Date.now() }],
        timestamp: Date.now() - 500,
        isStreaming: false,
        // Note: NO origin, NO extra.stream — matches real draft behavior
      });
    });

    await history.waitUntilPending();
    history.expectPending();

    // Server returns the formal message for the same invocation
    await history.resolve({
      messages: [
        { id: 'b1', catId: 'opus', content: 'cached assistant', timestamp: cachedAssistantTs },
        {
          id: 'server-msg-1',
          catId: 'codex',
          content: 'Full completed response',
          thinking: 'My reasoning...',
          origin: 'stream',
          timestamp: Date.now(),
          extra: { stream: { invocationId: 'inv-1' } },
          toolEvents: [{ id: 'te-1', type: 'tool_use', label: 'Read file', timestamp: Date.now() }],
        },
      ],
      hasMore: false,
    });

    // Bug B fix: only the formal message should survive, draft should be reconciled away
    const msgIds = useChatStore.getState().messages.map((m) => m.id);
    expect(msgIds).not.toContain('draft-inv-1');
    expect(msgIds).toContain('server-msg-1');
  });

  it('reconciles a server-hydrated draft payload with its richer formal message', async () => {
    const history = installDeferredHistoryResponse();
    const cachedAssistantTs = Date.now() - 1000;
    const now = Date.now();
    mountReplaceHydrationThread(makeThreadBState(cachedAssistantTs));
    const seededMessages: ChatMessage[] = [
      {
        id: 'b1',
        type: 'assistant' as const,
        catId: 'opus',
        content: 'cached assistant',
        timestamp: cachedAssistantTs,
      },
      {
        id: 'draft-inv-2',
        type: 'assistant' as const,
        catId: 'codex',
        content: 'partial draft content',
        thinking: 'draft thinking',
        thinkingChunks: ['draft thinking'],
        toolEvents: [{ id: 'te-draft-1', type: 'tool_use' as const, label: 'Read file', timestamp: now - 10 }],
        origin: 'stream' as const,
        extra: { stream: { invocationId: 'inv-2' } },
        timestamp: now - 20,
        isStreaming: true,
      },
    ];

    act(() => {
      useChatStore.setState((state) => ({
        messages: seededMessages,
        threadStates: {
          ...state.threadStates,
          'thread-b': {
            ...makeThreadBState(cachedAssistantTs),
            messages: seededMessages,
            hasActiveInvocation: true,
            catStatuses: { codex: 'streaming' },
            catInvocations: { codex: { invocationId: 'inv-2', startedAt: now - 200 } },
          },
        },
      }));
    });

    expect(useChatStore.getState().messages.map((m) => m.id)).toContain('draft-inv-2');

    await history.waitUntilPending();
    history.expectPending();

    await history.resolve({
      messages: [
        { id: 'b1', catId: 'opus', content: 'cached assistant', timestamp: cachedAssistantTs },
        {
          id: 'server-msg-2',
          catId: 'codex',
          content: 'full completed response',
          thinking: 'draft thinking\n\n---\n\nfinal reasoning',
          origin: 'stream',
          timestamp: now,
          extra: { stream: { invocationId: 'inv-2' } },
          toolEvents: [
            { id: 'te-draft-1', type: 'tool_use', label: 'Read file', timestamp: now - 10 },
            { id: 'te-draft-2', type: 'tool_use', label: 'Write file', timestamp: now },
          ],
        },
      ],
      hasMore: false,
    });

    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['b1', 'server-msg-2']);
    expect(useChatStore.getState().messages.find((m) => m.id === 'draft-inv-2')).toBeUndefined();
    expect(useChatStore.getState().messages.find((m) => m.id === 'server-msg-2')).toEqual(
      expect.objectContaining({
        content: 'full completed response',
        thinking: 'draft thinking\n\n---\n\nfinal reasoning',
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-2' } },
        toolEvents: [
          expect.objectContaining({ id: 'te-draft-1', type: 'tool_use', label: 'Read file' }),
          expect.objectContaining({ id: 'te-draft-2', type: 'tool_use', label: 'Write file' }),
        ],
      }),
    );
    expect(useChatStore.getState().messages.find((m) => m.id === 'server-msg-2')?.thinkingChunks).toBeUndefined();
  });

  it('preserves local blob URLs when a kept stream bubble survives replace hydration', async () => {
    const history = installDeferredHistoryResponse();
    const cachedAssistantTs = Date.now() - 1000;
    const blobUrl = 'blob:live-image-1';
    mountReplaceHydrationThread(makeThreadBState(cachedAssistantTs));

    act(() => {
      useChatStore.getState().addMessage({
        id: 'live-blob',
        type: 'assistant',
        catId: 'opus',
        content: 'local image bubble',
        contentBlocks: [{ type: 'image', url: blobUrl }],
        timestamp: Date.now(),
        isStreaming: true,
        origin: 'stream',
      });
    });

    await history.waitUntilPending();
    history.expectPending();

    await history.resolve({
      messages: [{ id: 'b1', catId: 'opus', content: 'cached assistant', timestamp: cachedAssistantTs }],
      hasMore: false,
    });

    expect(revokeSpy).not.toHaveBeenCalledWith(blobUrl);
    expect(useChatStore.getState().messages.find((m) => m.id === 'live-blob')?.contentBlocks).toEqual([
      { type: 'image', url: blobUrl },
    ]);
  });
});
