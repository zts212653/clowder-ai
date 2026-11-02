import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import type { ChatMessage, ThreadState } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import {
  __resetPendingCrossPostScrollForTest,
  peekPendingCrossPostScroll,
  setPendingCrossPostScroll,
} from '@/utils/crosspost-scroll-target';
import { loadThreadMessages } from '@/utils/offline-store';
import { __resetPendingTeleportForTest, peekPendingTeleport, setPendingTeleport } from '@/utils/teleport';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/offline-store', () => ({
  loadThreadMessages: vi.fn().mockResolvedValue(null),
  saveThreadMessages: vi.fn().mockResolvedValue(undefined),
  loadThreadActiveState: vi.fn().mockResolvedValue(null),
  saveThreadActiveState: vi.fn().mockResolvedValue(undefined),
}));

const THREAD_ID = 'thread-approval-card';
const CACHED_MESSAGE: ChatMessage = {
  id: 'old-message',
  type: 'assistant',
  catId: 'codex-sol',
  content: 'cached thread content',
  timestamp: 1,
};
const APPROVAL_CARD: ChatMessage = {
  id: 'new-approval-card',
  type: 'assistant',
  catId: 'codex-sol',
  content: '提议新建 thread：Review clowder-ai-plugins#22',
  timestamp: 2,
};
const CROSS_POST_SOURCE: ChatMessage = {
  id: 'new-cross-post-source',
  type: 'assistant',
  catId: 'codex-sol',
  content: 'source bubble newer than the cached page',
  timestamp: 3,
  extra: { stream: { turnInvocationId: 'turn-new-source' } },
};

function cachedThreadState(): ThreadState {
  return {
    messages: [CACHED_MESSAGE],
    isLoading: false,
    isLoadingHistory: false,
    hasMore: false,
    hasActiveInvocation: false,
    activeInvocations: {},
    intentMode: null,
    targetCats: [],
    catStatuses: {},
    catStatusDetails: {},
    catInvocations: {},
    unreadCount: 0,
    hasUserMention: false,
    lastActivity: CACHED_MESSAGE.timestamp,
    queue: [],
    queueFull: false,
    workspaceWorktreeId: null,
    workspaceOpenTabs: [],
    workspaceOpenFilePath: null,
    workspaceOpenFileLine: null,
  };
}

function HookProbe() {
  useChatHistory(THREAD_ID);
  return null;
}

function HookHost() {
  return React.createElement(ThreadChatHistoryAdmissionProvider, null, React.createElement(HookProbe));
}

describe('useChatHistory approval-card teleport refresh', () => {
  let container: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);

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
    __resetPendingTeleportForTest();
    __resetPendingCrossPostScrollForTest();
    useChatStore.setState({
      currentThreadId: THREAD_ID,
      messages: [CACHED_MESSAGE],
      hasMore: false,
      isLoadingHistory: false,
      hasActiveInvocation: false,
      threadStates: { [THREAD_ID]: cachedThreadState() },
    });
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/api/messages?')) {
        return {
          ok: true,
          json: async () => ({ messages: [CACHED_MESSAGE, APPROVAL_CARD, CROSS_POST_SOURCE], hasMore: false }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    apiFetchMock.mockReset();
    __resetPendingTeleportForTest();
    __resetPendingCrossPostScrollForTest();
    vi.restoreAllMocks();
  });

  it('revalidates a cached thread when the requested approval-card anchor is missing', async () => {
    setPendingTeleport({ threadId: THREAD_ID, messageId: APPROVAL_CARD.id });

    await act(async () => {
      root.render(React.createElement(HookHost));
      await Promise.resolve();
      await Promise.resolve();
    });

    const historyCall = apiFetchMock.mock.calls.find(([url]) => String(url).startsWith('/api/messages?'));
    expect(historyCall?.[0]).toBe(`/api/messages?limit=50&threadId=${THREAD_ID}`);
    expect(useChatStore.getState().messages.map((message) => message.id)).toContain(APPROVAL_CARD.id);
    expect(peekPendingTeleport(THREAD_ID)).toBeNull();
  });

  it('keeps a cold-thread source target until fresh history can page back to it', async () => {
    useChatStore.setState({ messages: [], hasMore: false, threadStates: {} });
    setPendingTeleport({ threadId: THREAD_ID, messageId: CACHED_MESSAGE.id });
    apiFetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/messages') {
        const older = url.searchParams.has('before');
        return {
          ok: true,
          json: async () => ({
            messages: older ? [CACHED_MESSAGE] : [APPROVAL_CARD, CROSS_POST_SOURCE],
            hasMore: !older,
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    await act(async () => {
      root.render(React.createElement(HookHost));
      await Promise.resolve();
      await Promise.resolve();
    });

    const historyUrls = apiFetchMock.mock.calls
      .map(([url]) => new URL(String(url), 'http://localhost'))
      .filter((url) => url.pathname === '/api/messages');
    expect(historyUrls.map((url) => url.searchParams.get('before'))).toEqual([null, '2:new-approval-card']);
    expect(useChatStore.getState().messages.map((message) => message.id)).toContain(CACHED_MESSAGE.id);
    expect(peekPendingTeleport(THREAD_ID)).toBeNull();
  });

  it('does not treat an unread cold-thread snapshot as an authoritative missing source', async () => {
    useChatStore.setState({ messages: [], hasMore: false, threadStates: {} });
    let finishSnapshot: (value: null) => void = () => {};
    const snapshot = new Promise<null>((resolve) => {
      finishSnapshot = resolve;
    });
    vi.mocked(loadThreadMessages).mockReturnValueOnce(snapshot);
    setPendingTeleport({ threadId: THREAD_ID, messageId: APPROVAL_CARD.id });

    await act(async () => {
      root.render(React.createElement(HookHost));
    });
    const pendingBeforeSnapshot = peekPendingTeleport(THREAD_ID);
    const requestedHistoryBeforeSnapshot = apiFetchMock.mock.calls.some(([url]) =>
      String(url).startsWith('/api/messages?'),
    );
    await act(async () => {
      finishSnapshot(null);
    });

    expect(requestedHistoryBeforeSnapshot).toBe(false);
    expect(pendingBeforeSnapshot?.messageId).toBe(APPROVAL_CARD.id);
    expect(useChatStore.getState().messages.map((message) => message.id)).toContain(APPROVAL_CARD.id);
  });

  it('finishes an absent cold-thread target after an authoritative empty page arrives', async () => {
    useChatStore.setState({ messages: [], hasMore: false, threadStates: {} });
    let finishHistory: (value: Response) => void = () => {};
    const history = new Promise<Response>((resolve) => {
      finishHistory = resolve;
    });
    apiFetchMock.mockImplementation(async (input) =>
      String(input).startsWith('/api/messages?') ? history : ({ ok: true, json: async () => ({}) } as Response),
    );
    setPendingTeleport({ threadId: THREAD_ID, messageId: 'missing-source' });

    await act(async () => {
      root.render(React.createElement(HookHost));
    });
    const pendingBeforeHistory = peekPendingTeleport(THREAD_ID);
    await act(async () => {
      finishHistory({ ok: true, json: async () => ({ messages: [], hasMore: false }) } as Response);
    });

    expect(pendingBeforeHistory?.messageId).toBe('missing-source');
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().hasMore).toBe(false);
    expect(peekPendingTeleport(THREAD_ID)).toBeNull();
  });

  it('revalidates a cached thread when a requested cross-post source is missing', async () => {
    setPendingCrossPostScroll({
      threadId: THREAD_ID,
      sourceInvocationId: 'turn-new-source',
      senderCatId: 'codex-sol',
    });

    await act(async () => {
      root.render(React.createElement(HookHost));
      await Promise.resolve();
      await Promise.resolve();
    });

    const historyCall = apiFetchMock.mock.calls.find(([url]) => String(url).startsWith('/api/messages?'));
    expect(historyCall?.[0]).toBe(`/api/messages?limit=50&threadId=${THREAD_ID}`);
    expect(useChatStore.getState().messages.map((message) => message.id)).toContain(CROSS_POST_SOURCE.id);
    expect(peekPendingCrossPostScroll(THREAD_ID)).toBeNull();
  });

  it('cancels a pending anchor-scroll retry when the history hook unmounts', async () => {
    let nextFrameId = 1;
    const pendingFrames = new Set<number>();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => {
      const frameId = nextFrameId++;
      pendingFrames.add(frameId);
      return frameId;
    });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frameId) => {
      pendingFrames.delete(frameId);
    });
    setPendingTeleport({ threadId: THREAD_ID, messageId: APPROVAL_CARD.id });

    await act(async () => {
      root.render(React.createElement(HookHost));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pendingFrames.size).toBe(1);
    const activeFrameId = [...pendingFrames][0];

    act(() => root.render(null));

    expect(cancelFrame).toHaveBeenCalledWith(activeFrameId);
    expect(pendingFrames.size).toBe(0);
  });
});
