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

  it('keeps a delivered input routing warning attached to its History bubble', () => {
    const message: ChatMessageData = {
      id: 'message-with-routing-warning',
      type: 'user',
      content: '@missing-cat please inspect this',
      timestamp: 1,
      extra: {
        routingWarnings: [{ kind: 'cat_not_found', mention: '@missing-cat', alternatives: [] }],
      },
    };

    act(() => {
      root.render(<ChatMessage message={message} threadId="thread-render" getCatById={() => undefined} />);
    });

    const warning = container.querySelector<HTMLElement>('[data-testid="routing-warning"]');
    expect(warning?.textContent).toContain('@missing-cat 不存在');
  });

  it('does not invent a Thinking state before real reasoning or streamed content exists', () => {
    const message: ChatMessageData = {
      id: 'message-empty-stream',
      type: 'assistant',
      catId: 'codex-sol',
      content: '',
      isStreaming: true,
      timestamp: 1,
    };

    act(() => {
      root.render(<ChatMessage message={message} threadId="thread-render" getCatById={() => undefined} />);
    });

    expect(container.textContent).not.toContain('Thinking...');
  });

  it('renders each appended lifecycle input below the response bubble', () => {
    const initial: ChatMessageData = {
      id: 'source-initial',
      from: { kind: 'user', userId: 'co-creator' },
      type: 'user',
      content: '@狸花猫 开始',
      timestamp: 100,
    };
    const appended: ChatMessageData = {
      id: 'source-appended',
      from: { kind: 'user', userId: 'co-creator' },
      type: 'user',
      content: '@狸花猫 测试下追加消息的',
      timestamp: new Date(2026, 8, 1, 22, 14, 8).getTime(),
    };
    const response: ChatMessageData = {
      id: 'response-with-append',
      from: { kind: 'agent', catId: 'cat-1' },
      type: 'assistant',
      catId: 'cat-1',
      content: '收到',
      timestamp: 100,
      lifecycle: {
        kind: 'response',
        orderKey: '100:response-with-append',
        invocationId: 'invocation-1',
        targetId: 'cat-1',
        inputEntryIds: ['entry-initial', 'entry-appended'],
        inputMessageIds: [initial.id, appended.id],
        status: 'completed',
        startedAt: 100,
        completedAt: new Date(2026, 8, 1, 22, 14, 9).getTime(),
      },
    };
    useChatStore.setState({ messages: [initial, appended, response] });

    act(() => {
      root.render(<ChatMessage message={response} threadId="thread-render" getCatById={() => undefined} />);
    });

    const receipts = container.querySelector('[data-testid="appended-input-receipts"]');
    expect(receipts?.textContent).toContain('补充消息');
    expect(receipts?.textContent).toContain('@狸花猫 测试下追加消息的');
    expect(receipts?.textContent).toContain('查看消息');
    expect(receipts?.textContent).toContain('09-01 22:14:08');
    expect(receipts?.textContent).not.toContain('@狸花猫 开始');
  });
});
