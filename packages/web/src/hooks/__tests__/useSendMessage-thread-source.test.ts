import React, { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();
const mockAddMessage = vi.fn();
const mockAddMessageToThread = vi.fn();
const mockRemoveMessage = vi.fn();
const mockRemoveThreadMessage = vi.fn();
const mockSetLoading = vi.fn();
const mockSetHasActiveInvocation = vi.fn();
const mockSetThreadLoading = vi.fn();
const mockSetThreadHasActiveInvocation = vi.fn();
const mockReplaceMessageId = vi.fn();
const mockReplaceThreadMessageId = vi.fn();
const mockResetRefs = vi.fn();
const mockProcessCommand = vi.fn(async () => false);
let storeCurrentThreadId = 'thread-stale';

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/hooks/useAgentMessages', () => ({
  useAgentMessages: () => ({ resetRefs: mockResetRefs }),
}));

vi.mock('@/hooks/useChatCommands', () => ({
  useChatCommands: () => ({ processCommand: mockProcessCommand }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    () => ({
      addMessage: mockAddMessage,
      addMessageToThread: mockAddMessageToThread,
      removeMessage: mockRemoveMessage,
      removeThreadMessage: mockRemoveThreadMessage,
      setLoading: mockSetLoading,
      setHasActiveInvocation: mockSetHasActiveInvocation,
      setThreadLoading: mockSetThreadLoading,
      setThreadHasActiveInvocation: mockSetThreadHasActiveInvocation,
      replaceMessageId: mockReplaceMessageId,
      replaceThreadMessageId: mockReplaceThreadMessageId,
      currentThreadId: storeCurrentThreadId,
    }),
    {
      getState: () => ({ currentThreadId: storeCurrentThreadId }),
    },
  ),
}));

import { useSendMessage } from '@/hooks/useSendMessage';

function SendRunner({
  activeThreadId,
  overrideThreadId,
  onDone,
}: {
  activeThreadId?: string;
  overrideThreadId?: string;
  onDone: () => void;
}) {
  const { handleSend } = useSendMessage(activeThreadId);
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;
    handleSend('@布偶 @缅因 看图', undefined, overrideThreadId).then(onDone);
  }, [handleSend, onDone, overrideThreadId]);

  return null;
}

describe('useSendMessage thread source', () => {
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
    mockApiFetch.mockReset();
    mockAddMessage.mockReset();
    mockAddMessageToThread.mockReset();
    mockRemoveMessage.mockReset();
    mockRemoveThreadMessage.mockReset();
    mockSetLoading.mockReset();
    mockSetHasActiveInvocation.mockReset();
    mockSetThreadLoading.mockReset();
    mockSetThreadHasActiveInvocation.mockReset();
    mockReplaceMessageId.mockReset();
    mockReplaceThreadMessageId.mockReset();
    mockResetRefs.mockReset();
    mockProcessCommand.mockReset();
    mockProcessCommand.mockResolvedValue(false);
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    storeCurrentThreadId = 'thread-stale';

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('uses route threadId instead of stale store currentThreadId', async () => {
    await act(async () => {
      root.render(
        React.createElement(SendRunner, {
          activeThreadId: 'thread-route',
          overrideThreadId: undefined,
          onDone: () => {},
        }),
      );
    });

    expect(mockApiFetch).toHaveBeenCalled();
    const payload = JSON.parse(String(mockApiFetch.mock.calls[0]?.[1]?.body));
    expect(payload.threadId).toBe('thread-route');
    expect(payload.threadId).not.toBe('thread-stale');
  });

  it('falls back to useChatStore.getState().currentThreadId when route threadId is absent', async () => {
    await act(async () => {
      root.render(
        React.createElement(SendRunner, {
          activeThreadId: undefined,
          overrideThreadId: undefined,
          onDone: () => {},
        }),
      );
    });

    expect(mockApiFetch).toHaveBeenCalled();
    const payload = JSON.parse(String(mockApiFetch.mock.calls[0]?.[1]?.body));
    expect(payload.threadId).toBe('thread-stale');
  });

  it('sets loading/active flags on override target thread in split-pane send', async () => {
    await act(async () => {
      root.render(
        React.createElement(SendRunner, {
          activeThreadId: 'thread-route',
          overrideThreadId: 'thread-target',
          onDone: () => {},
        }),
      );
    });

    expect(mockSetThreadLoading).toHaveBeenCalledWith('thread-target', true);
    expect(mockSetThreadHasActiveInvocation).toHaveBeenCalledWith('thread-target', true);
    expect(mockSetLoading).not.toHaveBeenCalled();
  });

  it('routes send error message to override target thread in split-pane mode', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ detail: 'target thread send failed' }),
    });

    await act(async () => {
      root.render(
        React.createElement(SendRunner, {
          activeThreadId: 'thread-route',
          overrideThreadId: 'thread-target',
          onDone: () => {},
        }),
      );
    });

    const systemCall = mockAddMessageToThread.mock.calls.find(
      ([, msg]) =>
        typeof msg === 'object' && msg !== null && 'type' in msg && (msg as { type?: string }).type === 'system',
    );
    expect(systemCall?.[0]).toBe('thread-target');
    expect(systemCall?.[1]).toMatchObject({
      type: 'system',
      variant: 'error',
      content: expect.stringContaining('target thread send failed'),
    });
  });

  it('clears invocation state for source thread when send fails after thread switch', async () => {
    let rejectFetch: ((err: Error) => void) | null = null;
    mockApiFetch.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectFetch = reject;
        }),
    );

    await act(async () => {
      root.render(
        React.createElement(SendRunner, {
          activeThreadId: 'thread-A',
          overrideThreadId: undefined,
          onDone: () => {},
        }),
      );
    });

    // Simulate user switching to another thread before the request rejects.
    storeCurrentThreadId = 'thread-B';

    await act(async () => {
      rejectFetch?.(new Error('network down'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockSetThreadLoading).toHaveBeenCalledWith('thread-A', false);
    expect(mockSetThreadHasActiveInvocation).toHaveBeenCalledWith('thread-A', false);
    expect(mockSetLoading).not.toHaveBeenCalledWith(false);
    expect(mockSetHasActiveInvocation).not.toHaveBeenCalledWith(false);
  });

  it('reconciles an optimistic active-thread user message to the persisted server message id', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'processing', userMessageId: 'msg-server-1' }),
    });

    await act(async () => {
      root.render(
        React.createElement(SendRunner, {
          activeThreadId: 'thread-route',
          overrideThreadId: undefined,
          onDone: () => {},
        }),
      );
    });

    const optimisticUserCall = mockAddMessage.mock.calls[0];
    const optimisticMessage = optimisticUserCall?.[0];
    expect(optimisticMessage).toMatchObject({ type: 'user' });
    expect(mockReplaceThreadMessageId).toHaveBeenCalledWith('thread-route', optimisticMessage.id, 'msg-server-1');
  });

  it('removes an optimistic active-thread user bubble when server smart-defaults to queued', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'queued', userMessageId: 'msg-server-queued' }),
    });

    await act(async () => {
      root.render(
        React.createElement(SendRunner, {
          activeThreadId: 'thread-route',
          overrideThreadId: undefined,
          onDone: () => {},
        }),
      );
    });

    const optimisticUserCall = mockAddMessage.mock.calls[0];
    const optimisticMessage = optimisticUserCall?.[0] as { id: string };
    expect(optimisticMessage).toMatchObject({ type: 'user' });
    expect(mockRemoveMessage).toHaveBeenCalledWith(optimisticMessage.id);
    expect(mockReplaceThreadMessageId).not.toHaveBeenCalled();
  });

  it('uses a valid UUIDv4-shaped idempotencyKey when crypto.randomUUID is unavailable', async () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { ...originalCrypto, randomUUID: undefined },
    });

    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'processing', userMessageId: 'msg-server-uuid' }),
    });

    try {
      await act(async () => {
        root.render(
          React.createElement(SendRunner, {
            activeThreadId: 'thread-route',
            overrideThreadId: undefined,
            onDone: () => {},
          }),
        );
      });

      const payload = JSON.parse(String(mockApiFetch.mock.calls[0]?.[1]?.body));
      expect(payload.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });

  it('removes an optimistic split-pane user bubble when server smart-defaults to queued', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'queued', userMessageId: 'msg-server-2' }),
    });

    await act(async () => {
      root.render(
        React.createElement(SendRunner, {
          activeThreadId: 'thread-route',
          overrideThreadId: 'thread-target',
          onDone: () => {},
        }),
      );
    });

    const optimisticUserCall = mockAddMessageToThread.mock.calls.find(
      ([, msg]) =>
        typeof msg === 'object' && msg !== null && 'type' in msg && (msg as { type?: string }).type === 'user',
    );
    const optimisticMessage = optimisticUserCall?.[1] as { id: string };
    expect(optimisticUserCall?.[0]).toBe('thread-target');
    expect(mockRemoveThreadMessage).toHaveBeenCalledWith('thread-target', optimisticMessage.id);
    expect(mockReplaceThreadMessageId).not.toHaveBeenCalled();
  });
});
