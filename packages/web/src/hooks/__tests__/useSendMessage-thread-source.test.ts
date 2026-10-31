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

import { registerComposerDraftObserver } from '@/components/composer-draft-flush-registry';
import { useSendMessage } from '@/hooks/useSendMessage';

function SendRunner({
  activeThreadId,
  overrideThreadId,
  contextAttachments,
  explicitTargetCats,
  idempotencyKey,
  consumeComposerDraft,
  onDone,
}: {
  activeThreadId?: string;
  overrideThreadId?: string;
  contextAttachments?: ContextAttachment[];
  idempotencyKey?: string;
  consumeComposerDraft?: boolean;
  explicitTargetCats?: string[];
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
      undefined,
      contextAttachments,
      explicitTargetCats,
      { idempotencyKey, consumeComposerDraft },
    ).then(onDone);
  }, [
    idempotencyKey,
    consumeComposerDraft,
    contextAttachments,
    explicitTargetCats,
    handleSend,
    onDone,
    overrideThreadId,
  ]);

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

  it.each([true, false])('a non-composer send cannot consume the mounted draft (ready=%s)', async (ready) => {
    const unregister = registerComposerDraftObserver('thread-route', () => ({
      text: '未发送的真正草稿',
      revision: 69,
      ready,
    }));
    try {
      await act(async () =>
        root.render(React.createElement(SendRunner, { activeThreadId: 'thread-route', onDone: () => {} })),
      );
      const payload = JSON.parse(String(mockApiFetch.mock.calls[0]?.[1]?.body));
      expect(payload.content).not.toBe('未发送的真正草稿');
      expect(payload.composerDraftRevision).toBeUndefined();
    } finally {
      unregister();
    }
  });

  it('an explicit composer send carries the mounted revision before its pending admission settles', async () => {
    const unregister = registerComposerDraftObserver('thread-route', () => ({ text: '', revision: 69, ready: false }));
    try {
      await act(async () =>
        root.render(
          React.createElement(SendRunner, {
            activeThreadId: 'thread-route',
            consumeComposerDraft: true,
            onDone: () => {},
          }),
        ),
      );
      const payload = JSON.parse(String(mockApiFetch.mock.calls[0]?.[1]?.body));
      expect(payload.composerDraftRevision).toBe(69);
    } finally {
      unregister();
    }
  });

  it('carries structured attachments without client-side delivery policy fields', async () => {
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
          contextAttachments: [attachment],
          onDone: () => {},
        }),
      );
    });

    const payload = JSON.parse(String(mockApiFetch.mock.calls[0]?.[1]?.body));
    expect(payload).toMatchObject({
      threadId: 'thread-route',
      contextAttachments: [attachment],
    });
    expect(payload).not.toHaveProperty('messageDisposition');
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
