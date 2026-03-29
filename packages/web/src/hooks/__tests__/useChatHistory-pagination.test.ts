/**
 * #80 Cloud R8 P2 regression: handleScroll cursor must skip draft rows.
 *
 * Draft messages have synthetic IDs (draft-xxx) that break backend pagination.
 * These tests verify handleScroll picks the first non-draft message for cursor.
 */
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

/** Captures hook return for test access */
let capturedHook: ReturnType<typeof useChatHistory> | null = null;

function HookHost({ threadId }: { threadId: string }) {
  capturedHook = useChatHistory(threadId);
  return React.createElement('div', {
    ref: capturedHook.scrollContainerRef,
    style: { height: '100px', overflow: 'auto' },
  });
}

function makeThreadState(messages: ChatMessage[]): ThreadState {
  return {
    messages,
    isLoading: false,
    isLoadingHistory: false,
    hasMore: true,
    hasActiveInvocation: false,
    intentMode: null,
    targetCats: [],
    catStatuses: {},
    catInvocations: {},
    activeInvocations: {},
    currentGame: null,
    unreadCount: 0,
    hasUserMention: false,
    lastActivity: 0,
    queue: [],
    queuePaused: false,
    queueFull: false,
    workspaceWorktreeId: null,
    workspaceOpenTabs: [],
    workspaceOpenFilePath: null,
    workspaceOpenFileLine: null,
  };
}

describe('useChatHistory pagination cursor (#80 cloud R8 P2)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);
  const ts = 1700000000000;

  const draftMsg: ChatMessage = {
    id: 'draft-inv-stale',
    type: 'assistant',
    content: 'Stale draft',
    timestamp: ts - 2000,
    isStreaming: true,
  };
  const formalOldest: ChatMessage = {
    id: 'msg-formal-oldest',
    type: 'user',
    content: 'Oldest formal',
    timestamp: ts - 1000,
  };
  const formalNewest: ChatMessage = {
    id: 'msg-formal-newest',
    type: 'assistant',
    content: 'Newest',
    timestamp: ts,
  };

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    capturedHook = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    // Mock apiFetch: tasks fetch returns empty, history fetch returns empty.
    // hasMore must stay true so F123 force-refresh (triggered by draft-prefixed
    // messages in cached snapshot) does not clobber the pre-populated hasMore.
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [], tasks: [], hasMore: true }),
    } as Response);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    apiFetchMock.mockReset();
  });

  it('skips draft-prefixed messages when building pagination cursor', async () => {
    const msgs = [draftMsg, formalOldest, formalNewest];

    // Pre-populate threadStates so mount skips fetchHistory
    useChatStore.setState({
      messages: msgs,
      hasMore: true,
      isLoadingHistory: false,
      currentThreadId: 'thread-1',
      threadStates: { 'thread-1': makeThreadState(msgs) },
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-1' }));
    });

    // Clear mount-related calls (tasks fetch)
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [], hasMore: false }),
    } as Response);

    // Simulate scroll to top
    const scrollEl = capturedHook!.scrollContainerRef.current;
    Object.defineProperty(scrollEl, 'scrollTop', { value: 10, writable: true });

    act(() => {
      capturedHook?.handleScroll();
    });

    // fetchHistory should use the FORMAL message cursor, not the draft
    const msgCalls = apiFetchMock.mock.calls.filter((c) => (c[0] as string).includes('/api/messages'));
    expect(msgCalls.length).toBe(1);
    const url = msgCalls[0][0] as string;
    expect(url).toContain('msg-formal-oldest');
    expect(url).not.toContain('draft-');
  });

  it('does not paginate when only draft messages exist (no valid cursor)', async () => {
    const draftsOnly = [
      { ...draftMsg, id: 'draft-inv-1' },
      { ...draftMsg, id: 'draft-inv-2', timestamp: ts },
    ];

    useChatStore.setState({
      messages: draftsOnly,
      hasMore: true,
      isLoadingHistory: false,
      currentThreadId: 'thread-1',
      threadStates: { 'thread-1': makeThreadState(draftsOnly) },
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-1' }));
    });

    apiFetchMock.mockClear();

    const scrollEl = capturedHook!.scrollContainerRef.current;
    Object.defineProperty(scrollEl, 'scrollTop', { value: 10, writable: true });

    act(() => {
      capturedHook?.handleScroll();
    });

    // No fetchHistory should be called for messages — all are drafts
    const msgCalls = apiFetchMock.mock.calls.filter((c) => (c[0] as string).includes('/api/messages'));
    expect(msgCalls.length).toBe(0);
  });
});
