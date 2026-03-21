import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatContainer } from '@/components/ChatContainer';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/stores/chatStore', () => {
  const state = {
    messages: [
      {
        id: 'a2a-msg-1',
        type: 'assistant',
        catId: 'codex',
        content: 'A2A internal reply',
        timestamp: 1,
        a2aGroupId: 'a2a-group-1',
      },
    ],
    isLoading: false,
    hasActiveInvocation: false,
    intentMode: null,
    targetCats: [],
    catStatuses: {},
    catInvocations: {},
    activeInvocations: {},
    addMessage: vi.fn(),
    removeMessage: vi.fn(),
    setIntentMode: vi.fn(),
    setTargetCats: vi.fn(),
    clearCatStatuses: vi.fn(),
    setCurrentThread: vi.fn(),
    updateThreadTitle: vi.fn(),
    setCurrentGame: vi.fn(),
    currentGame: null,
    threads: [],
    queue: [],
    queuePaused: false,
    viewMode: 'single',
    splitPaneThreadIds: [],
    setSplitPaneThreadIds: vi.fn(),
    setSplitPaneTarget: vi.fn(),
    clearUnread: vi.fn(),
    confirmUnreadAck: vi.fn(),
    armUnreadSuppression: vi.fn(),
  };
  const hook = (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state);
  return { useChatStore: hook };
});

vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => ({
    tasks: [],
    addTask: vi.fn(),
    updateTask: vi.fn(),
    clearTasks: vi.fn(),
  }),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ cancelInvocation: vi.fn() }),
}));

vi.mock('@/hooks/useAgentMessages', () => ({
  useAgentMessages: () => ({
    handleAgentMessage: vi.fn(),
    handleStop: vi.fn(),
    resetRefs: vi.fn(),
    resetTimeout: vi.fn(),
  }),
}));

vi.mock('@/hooks/useChatHistory', () => ({
  useChatHistory: () => ({
    handleScroll: vi.fn(),
    scrollContainerRef: { current: null },
    messagesEndRef: { current: null },
    isLoadingHistory: false,
    hasMore: false,
  }),
}));

vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend: vi.fn() }),
}));

vi.mock('@/components/ChatMessage', () => ({
  ChatMessage: ({ message }: { message: { content: string } }) => message.content,
}));

vi.mock('@/components/ChatInput', () => ({
  ChatInput: () => null,
}));

vi.mock('@/components/ThreadSidebar', () => ({
  ThreadSidebar: () => null,
}));

vi.mock('@/components/RightStatusPanel', () => ({
  RightStatusPanel: () => null,
}));

vi.mock('@/components/ParallelStatusBar', () => ({
  ParallelStatusBar: () => null,
}));

vi.mock('@/components/QueuePanel', () => ({
  QueuePanel: () => null,
}));

vi.mock('@/components/ThinkingIndicator', () => ({
  ThinkingIndicator: () => null,
}));

vi.mock('@/components/A2ACollapsible', () => ({
  A2ACollapsible: ({
    group,
    renderMessage,
  }: {
    group: { messages: Array<unknown> };
    renderMessage: (msg: unknown) => React.ReactNode;
  }) => renderMessage(group.messages[0]),
}));

describe('ChatContainer A2A grouped messages', () => {
  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
  });

  it('preserves MessageActions for A2A-grouped assistant messages', () => {
    const html = renderToStaticMarkup(React.createElement(ChatContainer, { threadId: 'thread-1' }));

    expect(html).toContain('title="从这里分支"');
  });
});
