import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput, threadDrafts, threadImageDrafts } from '@/components/ChatInput';
import { ThreadItem } from '@/components/ThreadSidebar/ThreadItem';
import type { WhisperOptions } from '@/hooks/useSendMessage';
import type { DeliveryMode, Thread } from '@/stores/chat-types';
import { DEFAULT_THREAD_STATE, useChatStore } from '@/stores/chatStore';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [],
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
  }),
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => React.createElement('span', null, 'avatar'),
}));

vi.mock('@/components/ThreadCatStatus', () => ({
  ThreadCatStatus: () => null,
}));

vi.mock('@/components/ThreadSidebar/ThreadCatSettings', () => ({
  ThreadCatSettings: () => null,
}));

vi.mock('@/components/icons/HubIcon', () => ({
  HubIcon: () => React.createElement('span', null, 'hub'),
}));

vi.mock('@/components/icons/PawIcon', () => ({
  PawIcon: () => React.createElement('span', null, 'paw'),
}));

vi.mock('@/components/icons/SendIcon', () => ({
  SendIcon: () => React.createElement('span', null, 'send'),
}));

vi.mock('@/components/icons/LoadingIcon', () => ({
  LoadingIcon: () => React.createElement('span', null, 'loading'),
}));

vi.mock('@/components/icons/AttachIcon', () => ({
  AttachIcon: () => React.createElement('span', null, 'attach'),
}));

vi.mock('@/components/ThreadSidebar/thread-utils', () => ({
  formatRelativeTime: () => '1分',
}));

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://example.test',
  apiFetch: vi.fn(),
}));

vi.mock('@/utils/compressImage', () => ({ compressImage: (f: File) => Promise.resolve(f) }));

type OnSend = (content: string, images?: File[], whisper?: WhisperOptions, deliveryMode?: DeliveryMode) => void;

function makeThread(id: string, title: string): Thread {
  const now = Date.now();
  return {
    id,
    projectPath: 'default',
    title,
    participants: [] as string[],
    lastActiveAt: now,
    createdAt: now,
    createdBy: 'user',
    pinned: false,
    favorited: false,
  };
}

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  nativeSetter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function Host({ onSend }: { onSend: OnSend }) {
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const thread1State = useChatStore((s) => s.getThreadState('thread-1'));
  const thread2State = useChatStore((s) => s.getThreadState('thread-2'));

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(ThreadItem, {
      id: 'thread-1',
      title: 'Thread 1',
      participants: [],
      lastActiveAt: 1,
      isActive: currentThreadId === 'thread-1',
      onSelect: (id: string) => useChatStore.getState().setCurrentThread(id),
      threadState: thread1State,
    }),
    React.createElement(ThreadItem, {
      id: 'thread-2',
      title: 'Thread 2',
      participants: [],
      lastActiveAt: 1,
      isActive: currentThreadId === 'thread-2',
      onSelect: (id: string) => useChatStore.getState().setCurrentThread(id),
      threadState: thread2State,
    }),
    React.createElement(ChatInput, { key: currentThreadId, threadId: currentThreadId, onSend }),
  );
}

describe('ThreadItem draft badge', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    threadDrafts.clear();
    threadImageDrafts.clear();
    useChatStore.setState({
      messages: [],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: true,
      hasActiveInvocation: false,
      activeInvocations: {},
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      currentGame: null,
      queue: [],
      queuePaused: false,
      queueFull: false,
      threadStates: {
        'thread-1': { ...DEFAULT_THREAD_STATE },
        'thread-2': { ...DEFAULT_THREAD_STATE },
      },
      currentThreadId: 'thread-1',
      currentProjectPath: 'default',
      threads: [makeThread('thread-1', 'Thread 1'), makeThread('thread-2', 'Thread 2')],
      isLoadingThreads: false,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function getTextarea(): HTMLTextAreaElement {
    return container.querySelector('textarea') as HTMLTextAreaElement;
  }

  function getThreadRow(threadId: string): HTMLDivElement {
    return container.querySelector(`[data-thread-id="${threadId}"]`) as HTMLDivElement;
  }

  it('shows draft badge from threadState.hasDraft', () => {
    act(() => {
      root.render(
        React.createElement(ThreadItem, {
          id: 'thread-1',
          title: '未命名对话',
          participants: [],
          lastActiveAt: Date.now(),
          isActive: false,
          onSelect: vi.fn(),
          threadState: { ...DEFAULT_THREAD_STATE, hasDraft: true },
        }),
      );
    });

    expect(container.textContent).toContain('[草稿]');
  });

  it('does not show badge on the active thread while typing', () => {
    const onSend = vi.fn<OnSend>();

    act(() => {
      root.render(React.createElement(Host, { onSend }));
    });

    expect(getThreadRow('thread-1').textContent).not.toContain('[草稿]');

    act(() => {
      typeInto(getTextarea(), 'half typed message');
    });

    expect(getThreadRow('thread-1').textContent).not.toContain('[草稿]');

    act(() => {
      getTextarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onSend).toHaveBeenCalledWith('half typed message', undefined, undefined, undefined);
    expect(getThreadRow('thread-1').textContent).not.toContain('[草稿]');
  });

  it('preserves the badge on the previous thread after switching', () => {
    const onSend = vi.fn<OnSend>();

    act(() => {
      root.render(React.createElement(Host, { onSend }));
    });

    act(() => {
      typeInto(getTextarea(), 'draft A');
    });
    expect(getThreadRow('thread-1').textContent).not.toContain('[草稿]');

    act(() => {
      getThreadRow('thread-2').click();
    });

    expect(useChatStore.getState().currentThreadId).toBe('thread-2');
    expect(getThreadRow('thread-1').textContent).toContain('[草稿]');
    expect(getThreadRow('thread-2').textContent).not.toContain('[草稿]');
    expect(getTextarea().value).toBe('');
  });
});
