/**
 * F294 regression: cold history hydration must preserve a durable Message
 * Bundle carrier so ChatMessage can render MessageBundleCard after reload.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

function HookHost({ threadId }: { threadId: string }) {
  const history = useChatHistory(threadId);
  return React.createElement('div', {
    ref: history.scrollContainerRef,
    style: { height: '100px', overflow: 'auto' },
  });
}

const MESSAGE_BUNDLE = {
  v: 1 as const,
  sourceThreadId: 'thread-source',
  items: [{ kind: 'message' as const, messageId: 'source-message-1' }],
};

describe('F294 — cold hydration preserves Message Bundle carriers', () => {
  const apiFetchMock = vi.mocked(apiFetch);
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
      hasMore: false,
      isLoadingHistory: false,
      currentThreadId: 'thread-target',
      threadStates: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    apiFetchMock.mockReset();
  });

  it('copies extra.messageBundle into the hydrated chat message', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            id: 'bundle-carrier-1',
            type: 'user',
            content: '转发了 1 条聊天记录',
            extra: { messageBundle: MESSAGE_BUNDLE },
            timestamp: 1700000000000,
          },
        ],
        tasks: [],
        hasMore: false,
      }),
    } as Response);

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-target' }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().messages[0].extra?.messageBundle).toEqual(MESSAGE_BUNDLE);
  });
});
