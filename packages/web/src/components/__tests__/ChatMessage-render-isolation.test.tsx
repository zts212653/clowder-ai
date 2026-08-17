import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';

describe('ChatMessage render isolation', () => {
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
      currentThreadId: 'thread-render',
      messages: [],
      threads: [],
      isLoadingThreads: false,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('does not rerender an ordinary historical bubble when an unrelated message changes', () => {
    const message: ChatMessageData = {
      id: 'message-stable',
      type: 'assistant',
      catId: 'codex-sol',
      content: 'stable historical reply',
      timestamp: 1,
    };
    useChatStore.setState({ messages: [message] });
    const getCatById = vi.fn(() => undefined);

    act(() => {
      root.render(<ChatMessage message={message} threadId="thread-render" getCatById={getCatById} />);
    });
    const callsAfterInitialRender = getCatById.mock.calls.length;

    act(() => {
      useChatStore.setState({
        messages: [
          message,
          {
            id: 'message-streaming',
            type: 'assistant',
            catId: 'opus',
            content: 'new streaming delta',
            isStreaming: true,
            timestamp: 2,
          },
        ],
      });
    });

    expect(getCatById).toHaveBeenCalledTimes(callsAfterInitialRender);
  });
});
