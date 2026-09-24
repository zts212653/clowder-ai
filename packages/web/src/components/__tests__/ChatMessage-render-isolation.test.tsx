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
      metadata: { model: 'gpt-test', provider: 'test-provider' },
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
    const metadata = container.querySelector('[data-testid="message-metadata"]');
    const appendedRow = container.querySelector('[data-appended-input-id="source-appended"]');
    expect(metadata?.compareDocumentPosition(receipts!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(receipts?.textContent).toContain('补充消息');
    expect(receipts?.textContent).toContain('@狸花猫 测试下追加消息的');
    expect(receipts?.textContent).toContain('查看原文');
    expect(receipts?.textContent).not.toContain('09/01 22:14:08');
    expect(appendedRow?.getAttribute('title')).toContain('09/01 22:14:08');
    expect(appendedRow?.getAttribute('title')).toContain('@狸花猫 测试下追加消息的');
    expect(receipts?.textContent).not.toContain('@狸花猫 开始');
  });

  it('shows newest appended inputs first and expands the default three-and-a-half-row viewport', () => {
    const initial: ChatMessageData = {
      id: 'source-initial-many',
      from: { kind: 'user', userId: 'co-creator' },
      type: 'user',
      content: '开始',
      timestamp: 100,
    };
    const appended = Array.from(
      { length: 5 },
      (_, index): ChatMessageData => ({
        id: `source-appended-${index + 1}`,
        from: { kind: 'user', userId: 'co-creator' },
        type: 'user',
        content: `追加消息 ${index + 1}`,
        timestamp: 101 + index,
      }),
    );
    const response: ChatMessageData = {
      id: 'response-with-many-appends',
      from: { kind: 'agent', catId: 'cat-1' },
      type: 'assistant',
      catId: 'cat-1',
      content: '收到',
      timestamp: 100,
      lifecycle: {
        kind: 'response',
        orderKey: '100:response-with-many-appends',
        invocationId: 'invocation-many',
        targetId: 'cat-1',
        inputEntryIds: ['entry-initial', ...appended.map((_, index) => `entry-appended-${index + 1}`)],
        inputMessageIds: [initial.id, ...appended.map((message) => message.id)],
        status: 'processing',
        startedAt: 100,
      },
    };
    useChatStore.setState({ messages: [initial, ...appended, response] });

    act(() => {
      root.render(<ChatMessage message={response} threadId="thread-render" getCatById={() => undefined} />);
    });

    const list = container.querySelector('[data-testid="appended-input-list"]') as HTMLOListElement | null;
    const rows = [...container.querySelectorAll('[data-appended-input-id]')];
    expect(rows.map((row) => row.getAttribute('data-appended-input-id'))).toEqual([
      'source-appended-5',
      'source-appended-4',
      'source-appended-3',
      'source-appended-2',
      'source-appended-1',
    ]);
    expect(list?.dataset.collapsed).toBe('true');
    expect(list?.style.maxHeight).toBe('98px');
    expect(list?.style.maskImage).toContain('transparent 98px');

    const expand = container.querySelector('button[aria-expanded="false"]') as HTMLButtonElement | null;
    expect(expand?.getAttribute('aria-label')).toBe('展开剩余 2 条补充消息');
    expect(expand?.textContent).toBe('展开剩余 2 条');
    expect(expand?.querySelector('svg')).toBeNull();

    act(() => expand?.click());

    expect(list?.dataset.collapsed).toBe('false');
    expect(list?.style.maxHeight).toBe('');
    const collapse = container.querySelector('button[aria-expanded="true"]');
    expect(collapse?.getAttribute('aria-label')).toBe('收起补充消息');
    expect(collapse?.textContent).toBe('');
    expect(collapse?.querySelector('span')?.classList.contains('rotate-180')).toBe(true);
    expect(collapse?.querySelector('svg')?.classList.contains('rotate-90')).toBe(true);
  });

  it('renders only otherwise-invisible post_message targets at the end of the ordinary body', () => {
    const message: ChatMessageData = {
      id: 'explicit-post-with-structured-target',
      type: 'assistant',
      catId: 'cat-author',
      origin: 'callback',
      content: '正文',
      timestamp: 1,
      extra: {
        isExplicitPost: true,
        targetCats: ['cat-opus', 'cat-sol'],
      },
    };
    const getCatById = (catId: string) => {
      if (catId === 'cat-author') {
        return { id: catId, displayName: '作者猫', avatar: '', color: { primary: '#000', secondary: '#000' } } as never;
      }
      if (catId === 'cat-opus') {
        return { id: catId, displayName: '布偶猫', avatar: '', color: { primary: '#000', secondary: '#000' } } as never;
      }
      if (catId === 'cat-sol') {
        return { id: catId, displayName: '缅因猫', avatar: '', color: { primary: '#000', secondary: '#000' } } as never;
      }
      return undefined;
    };

    act(() => {
      root.render(<ChatMessage message={message} threadId="thread-render" getCatById={getCatById} />);
    });

    const targets = container.querySelector('[data-testid="implicit-structured-targets"]');
    expect(targets?.children).toHaveLength(2);
    expect(targets?.textContent).toContain('→ @布偶猫');
    expect(targets?.textContent).toContain('→ @缅因猫');
    expect(container.querySelector('[data-testid="message-header"]')?.textContent).not.toContain('→');
  });

  it('keeps an empty canceled response body compact without shrinking its shared header column', () => {
    const message: ChatMessageData = {
      id: 'canceled-response',
      type: 'assistant',
      catId: 'cat-1',
      origin: 'stream',
      content: '',
      timestamp: 1,
      lifecycle: {
        kind: 'response',
        orderKey: '1:canceled-response',
        invocationId: 'invocation-1',
        targetId: 'cat-1',
        inputEntryIds: ['entry-1'],
        inputMessageIds: ['message-1'],
        status: 'canceled',
        startedAt: 1,
        completedAt: 2,
      },
    };

    act(() => {
      root.render(<ChatMessage message={message} threadId="thread-render" getCatById={() => undefined} />);
    });

    const bubble = container.querySelector('[data-testid="message-bubble"]');
    expect(bubble?.textContent).toContain('已停止回复。');
    expect(container.querySelector('[data-response-lifecycle-notice]')).toBeNull();
    expect(bubble?.className).toContain('w-fit');
    expect(bubble?.parentElement?.className).not.toContain('w-fit');
  });

  it('shows a terminal response completion time instead of its original start time', () => {
    const startedAt = new Date(2026, 8, 22, 17, 6).getTime();
    const completedAt = new Date(2026, 8, 22, 17, 49).getTime();
    const message: ChatMessageData = {
      id: 'completed-response-time',
      type: 'assistant',
      catId: 'cat-1',
      content: 'done',
      timestamp: startedAt,
      timelineOrderAt: startedAt,
      lifecycle: {
        kind: 'response',
        orderKey: `${startedAt}:completed-response-time`,
        invocationId: 'invocation-time',
        targetId: 'cat-1',
        inputEntryIds: ['entry-time'],
        inputMessageIds: ['message-time'],
        status: 'completed',
        startedAt,
        completedAt,
      },
    };

    act(() => {
      root.render(
        <ChatMessage
          message={message}
          threadId="thread-render"
          getCatById={() =>
            ({
              id: 'cat-1',
              displayName: '测试猫',
              avatar: '',
              breedId: 'maine-coon',
              color: { primary: '#334455', secondary: '#ddeeff' },
            }) as never
          }
        />,
      );
    });

    const expected = new Date(completedAt).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const started = new Date(startedAt).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const header = container.querySelector('[data-testid="message-header"]');
    expect(header?.textContent).toContain(expected);
    expect(header?.textContent).not.toContain(started);
  });
});
