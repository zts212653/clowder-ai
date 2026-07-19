import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useChatCommands } from '@/hooks/useChatCommands';
import { useChatStore } from '@/stores/chatStore';
import { MiniThreadSidebar } from '../MiniThreadSidebar';
import { SplitPaneView } from '../SplitPaneView';

const mocks = vi.hoisted(() => ({
  router: { push: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [],
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
  }),
}));

const HOT_PATHS = [
  'src/components/ChatContainer.tsx',
  'src/components/ThreadSidebar/ThreadSidebar.tsx',
  'src/components/SplitPaneView.tsx',
  'src/components/MiniThreadSidebar.tsx',
  'src/hooks/useAgentMessages.ts',
  'src/hooks/useChatHistory.ts',
  'src/hooks/useSendMessage.ts',
  'src/hooks/useChatCommands.ts',
  'src/hooks/useChatSocketCallbacks.ts',
];

describe('chat store subscription scope', () => {
  it('keeps hot chat paths off whole-store useChatStore subscriptions', () => {
    const offenders = HOT_PATHS.filter((relPath) => {
      const source = readFileSync(join(process.cwd(), relPath), 'utf8');
      return /\buseChatStore\s*\(\s*\)/.test(source);
    });

    expect(offenders).toEqual([]);
  });
});

describe('useChatCommands render subscription', () => {
  const originalAddMessage = useChatStore.getState().addMessage;
  const originalShowVoteModal = useChatStore.getState().showVoteModal;
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container?.remove();
    root = null;
    container = null;
    useChatStore.setState({
      addMessage: originalAddMessage,
      showVoteModal: originalShowVoteModal,
    });
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('ignores unrelated updates and rerenders when its selected action changes', () => {
    let renderCount = 0;

    function Harness() {
      useChatCommands();
      renderCount += 1;
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(React.createElement(Harness)));
    expect(renderCount).toBe(1);

    act(() => {
      useChatStore.setState({ showVoteModal: !originalShowVoteModal });
    });
    expect(renderCount).toBe(1);

    act(() => {
      useChatStore.setState({ addMessage: vi.fn() as typeof originalAddMessage });
    });
    expect(renderCount).toBe(2);
  });
});

describe('MiniThreadSidebar thread-state subscription', () => {
  const originalState = useChatStore.getState();
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container?.remove();
    root = null;
    container = null;
    useChatStore.setState({
      threads: originalState.threads,
      splitPaneThreadIds: originalState.splitPaneThreadIds,
      currentThreadId: originalState.currentThreadId,
      threadStates: originalState.threadStates,
    });
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('refreshes a background thread unread badge when threadStates changes', () => {
    const threadId = 'subscription-test-thread';
    const backgroundState = useChatStore.getState().getThreadState(threadId);

    act(() => {
      useChatStore.setState({
        currentThreadId: 'default',
        threads: [
          {
            id: threadId,
            title: 'Subscription test',
            projectPath: '/test',
            createdBy: 'test-user',
            participants: [],
            lastActiveAt: 1,
            createdAt: 1,
          },
        ],
        splitPaneThreadIds: [],
        threadStates: {
          ...originalState.threadStates,
          [threadId]: { ...backgroundState, unreadCount: 1 },
        },
      });
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(React.createElement(MiniThreadSidebar, { onAssignToPane: vi.fn() })));
    expect(container.textContent).toContain('1');

    act(() => {
      useChatStore.setState((state) => ({
        threadStates: {
          ...state.threadStates,
          [threadId]: { ...state.threadStates[threadId], unreadCount: 2 },
        },
      }));
    });
    expect(container.textContent).toContain('2');
  });
});

describe('SplitPaneView thread-state subscription', () => {
  const originalState = useChatStore.getState();
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container?.remove();
    root = null;
    container = null;
    useChatStore.setState({
      threads: originalState.threads,
      splitPaneThreadIds: originalState.splitPaneThreadIds,
      splitPaneTargetId: originalState.splitPaneTargetId,
      currentThreadId: originalState.currentThreadId,
      threadStates: originalState.threadStates,
      activeInvocations: originalState.activeInvocations,
      targetCats: originalState.targetCats,
    });
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('refreshes the target input when a background pane starts an invocation', () => {
    const threadId = 'split-subscription-test-thread';
    const backgroundState = useChatStore.getState().getThreadState(threadId);

    act(() => {
      useChatStore.setState({
        currentThreadId: 'default',
        threads: [
          {
            id: threadId,
            title: 'Split subscription test',
            projectPath: '/test',
            createdBy: 'test-user',
            participants: [],
            lastActiveAt: 1,
            createdAt: 1,
          },
        ],
        splitPaneThreadIds: [threadId],
        splitPaneTargetId: threadId,
        threadStates: {
          ...originalState.threadStates,
          [threadId]: { ...backgroundState, hasActiveInvocation: false },
        },
      });
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        React.createElement(SplitPaneView, {
          onSend: vi.fn(),
          onStop: vi.fn(),
          onZoomToThread: vi.fn(),
        }),
      ),
    );
    expect(container.querySelector('[data-testid="active-invocation-banner"]')).toBeNull();

    act(() => {
      useChatStore.setState((state) => ({
        threadStates: {
          ...state.threadStates,
          [threadId]: { ...state.threadStates[threadId], hasActiveInvocation: true },
        },
      }));
    });
    expect(container.querySelector('[data-testid="active-invocation-banner"]')).not.toBeNull();
  });
});
