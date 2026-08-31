import type { ContextAttachment } from '@cat-cafe/shared';
import React, { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();
const mockAddMessageToThread = vi.fn();
const mockProcessCommand = vi.fn(async () => false);
let storeCurrentThreadId = 'thread-stale';

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/hooks/useChatCommands', () => ({
  useChatCommands: () => ({ processCommand: mockProcessCommand }),
}));

vi.mock('@/stores/chatStore', () => {
  const state = () => ({
    addMessageToThread: mockAddMessageToThread,
    currentThreadId: storeCurrentThreadId,
  });
  return {
    useChatStore: Object.assign((selector: (value: ReturnType<typeof state>) => unknown) => selector(state()), {
      getState: state,
    }),
  };
});

import { useSendMessage } from '@/hooks/useSendMessage';

function SendRunner({
  activeThreadId,
  overrideThreadId,
  postAdmissionAction,
  messageDisposition,
  contextAttachments,
  onDone,
}: {
  activeThreadId?: string;
  overrideThreadId?: string;
  postAdmissionAction?: 'steer';
  messageDisposition?: 'continue_current' | 'next_work';
  contextAttachments?: ContextAttachment[];
  onDone: (accepted: boolean) => void;
}) {
  const { handleSend } = useSendMessage(activeThreadId);
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;
    void handleSend(
      '@布偶 @缅因 看图',
      undefined,
      overrideThreadId,
      undefined,
      postAdmissionAction,
      undefined,
      messageDisposition,
      contextAttachments,
    ).then(onDone);
  }, [contextAttachments, handleSend, messageDisposition, onDone, overrideThreadId, postAdmissionAction]);

  return null;
}

describe('useSendMessage canonical Queue ingress', () => {
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
    mockAddMessageToThread.mockReset();
    mockProcessCommand.mockReset();
    mockProcessCommand.mockResolvedValue(false);
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: 'queued', entryId: 'entry-1', userMessageId: 'message-1' }),
    });
    storeCurrentThreadId = 'thread-stale';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('uses the route thread and never publishes a pre-admission History bubble', async () => {
    await act(async () => {
      root.render(React.createElement(SendRunner, { activeThreadId: 'thread-route', onDone: () => {} }));
    });

    const payload = JSON.parse(String(mockApiFetch.mock.calls[0]?.[1]?.body));
    expect(payload.threadId).toBe('thread-route');
    expect(payload.threadId).not.toBe('thread-stale');
    expect(payload).not.toHaveProperty('deliveryMode');
    expect(mockAddMessageToThread).not.toHaveBeenCalled();
  });

  it('carries disposition and structured attachments without a delivery-mode compatibility field', async () => {
    const attachment: ContextAttachment = {
      v: 1,
      id: 'ctx-thread-send',
      kind: 'thread',
      threadId: 'thread-source',
      title: 'Source Thread',
    };
    await act(async () => {
      root.render(
        React.createElement(SendRunner, {
          activeThreadId: 'thread-route',
          messageDisposition: 'continue_current',
          contextAttachments: [attachment],
          onDone: () => {},
        }),
      );
    });

    const payload = JSON.parse(String(mockApiFetch.mock.calls[0]?.[1]?.body));
    expect(payload).toMatchObject({
      threadId: 'thread-route',
      messageDisposition: 'continue_current',
      contextAttachments: [attachment],
    });
    expect(payload).not.toHaveProperty('deliveryMode');
    expect(mockAddMessageToThread).not.toHaveBeenCalled();
  });

  it('falls back to the store thread only when no explicit source thread exists', async () => {
    await act(async () => {
      root.render(React.createElement(SendRunner, { onDone: () => {} }));
    });

    const payload = JSON.parse(String(mockApiFetch.mock.calls[0]?.[1]?.body));
    expect(payload.threadId).toBe('thread-stale');
  });

  it('routes an admission error to the captured split-pane thread', async () => {
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

    expect(mockAddMessageToThread).toHaveBeenCalledWith(
      'thread-target',
      expect.objectContaining({
        type: 'system',
        variant: 'error',
        content: expect.stringContaining('target thread send failed'),
      }),
    );
  });

  it('keeps a delayed Queue admission out of History after a thread switch', async () => {
    let resolveFetch: ((value: object) => void) | undefined;
    mockApiFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    await act(async () => {
      root.render(React.createElement(SendRunner, { activeThreadId: 'thread-A', onDone: () => {} }));
      await Promise.resolve();
    });
    storeCurrentThreadId = 'thread-B';

    await act(async () => {
      resolveFetch?.({
        ok: true,
        status: 202,
        json: async () => ({ status: 'queued', entryId: 'entry-A' }),
      });
      await Promise.resolve();
    });

    expect(mockAddMessageToThread).not.toHaveBeenCalled();
  });

  it('implements draft Steer as Queue admission followed by the exact-entry command', async () => {
    const accepted: boolean[] = [];
    mockApiFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ status: 'queued', entryId: 'entry-steer' }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ started: true }) });

    await act(async () => {
      root.render(
        React.createElement(SendRunner, {
          activeThreadId: 'thread-route',
          postAdmissionAction: 'steer',
          onDone: (value) => accepted.push(value),
        }),
      );
    });

    expect(mockApiFetch).toHaveBeenNthCalledWith(1, '/api/messages', expect.any(Object));
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, '/api/threads/thread-route/queue/entry-steer/steer', {
      method: 'POST',
    });
    expect(accepted).toEqual([true]);
    expect(mockAddMessageToThread).not.toHaveBeenCalled();
  });

  it('keeps an accepted Queue entry accepted when its follow-up Steer loses the race', async () => {
    const accepted: boolean[] = [];
    mockApiFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ status: 'queued', entryId: 'entry-steer' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: 'Steer 状态已变化，请重试' }),
      });

    await act(async () => {
      root.render(
        React.createElement(SendRunner, {
          activeThreadId: 'thread-route',
          postAdmissionAction: 'steer',
          onDone: (value) => accepted.push(value),
        }),
      );
    });

    expect(accepted).toEqual([true]);
    expect(mockAddMessageToThread).toHaveBeenCalledWith(
      'thread-route',
      expect.objectContaining({ content: expect.stringContaining('Steer 状态已变化') }),
    );
  });

  it('uses a UUIDv4-shaped idempotency key when crypto.randomUUID is unavailable', async () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { ...originalCrypto, randomUUID: undefined },
    });

    try {
      await act(async () => {
        root.render(React.createElement(SendRunner, { activeThreadId: 'thread-route', onDone: () => {} }));
      });
      const payload = JSON.parse(String(mockApiFetch.mock.calls[0]?.[1]?.body));
      expect(payload.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto });
    }
  });
});
