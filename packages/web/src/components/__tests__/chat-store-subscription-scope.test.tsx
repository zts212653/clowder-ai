import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useChatCommands } from '@/hooks/useChatCommands';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { MiniThreadSidebar } from '../MiniThreadSidebar';
import { SplitPaneView } from '../SplitPaneView';

const mocks = vi.hoisted(() => ({
  router: { push: vi.fn() },
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    void path;
    void init;
    return new Response('{}', { status: 200 });
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: mocks.apiFetch,
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
  const originalAddMessageToThread = useChatStore.getState().addMessageToThread;
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
      addMessageToThread: originalAddMessageToThread,
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
      useChatStore.setState({ addMessageToThread: vi.fn() as typeof originalAddMessageToThread });
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
    useActiveExecutionStore.getState().reset();
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockImplementation(async () => new Response('{}', { status: 200 }));
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

  it('uses terminal-projected liveness for the split-pane banner and Stop control', () => {
    const threadId = 'split-terminal-projection-thread';
    const backgroundState = useChatStore.getState().getThreadState(threadId);

    act(() => {
      useChatStore.setState({
        currentThreadId: 'default',
        threads: [
          {
            id: threadId,
            title: 'Split terminal projection',
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
          [threadId]: {
            ...backgroundState,
            hasActiveInvocation: true,
            activeInvocations: { 'inv-closed': { catId: 'codex-sol', mode: 'execute' } },
            targetCats: ['codex-sol'],
            catStatuses: { 'codex-sol': 'streaming' },
            catInvocations: {
              'codex-sol': {
                invocationId: 'inv-closed',
                appServerLifecycle: {
                  stage: 'closed',
                  lastActivityAt: 123,
                  recoveryAttempt: 0,
                  turnStartSent: true,
                  turnAccepted: true,
                  itemObserved: true,
                },
              },
            },
          },
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
          onZoomToThread: vi.fn(),
        }),
      ),
    );

    expect(container.querySelector('[data-testid="active-invocation-banner"]')).toBeNull();
    expect(container.querySelector('[aria-label="Stop generation"]')).toBeNull();

    act(() => {
      useChatStore.getState().setThreadHasActiveInvocation(threadId, true);
    });

    expect(useChatStore.getState().threadStates[threadId]?.activeInvocations).toEqual({});
    expect(container.querySelector('[data-testid="active-invocation-banner"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Stop generation"]')).not.toBeNull();

    act(() => {
      useChatStore.setState((state) => ({
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...state.threadStates[threadId],
            activeInvocations: { 'inv-new': { catId: 'codex-sol', mode: 'execute' } },
          },
        },
      }));
    });

    expect(container.querySelector('[data-testid="active-invocation-banner"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Stop generation"]')).not.toBeNull();
  });

  it('does not expose an actionable legacy Stop while an exact execution target is unavailable', () => {
    const threadId = 'split-disconnected-thread';
    const backgroundState = useChatStore.getState().getThreadState(threadId);
    useChatStore.setState({
      currentThreadId: 'default',
      threads: [
        {
          id: threadId,
          title: 'Disconnected split',
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
        [threadId]: {
          ...backgroundState,
          hasActiveInvocation: true,
          activeInvocations: { 'legacy-inv': { catId: 'codex-sol', mode: 'execute' } },
        },
      },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        React.createElement(SplitPaneView, {
          onSend: vi.fn(),
          onZoomToThread: vi.fn(),
        }),
      ),
    );

    expect(container.querySelector('[data-testid="active-invocation-banner"]')?.textContent).toContain(
      '正在确认运行状态',
    );
    const stop = container.querySelector('[aria-label="Stop generation"]') as HTMLButtonElement | null;
    expect(stop?.disabled).toBe(true);
  });

  it('cancels the exact canonical execution over REST instead of the legacy socket callback', async () => {
    const threadId = 'split-canonical-cancel-thread';
    const execution = {
      executionId: 'inv-exact',
      threadId,
      threadTitle: 'Canonical split',
      catId: 'codex-sol',
      kind: 'live_invocation' as const,
      startedAt: 1,
      cancelability: {
        state: 'cancelable' as const,
        target: {
          kind: 'live_invocation' as const,
          threadId,
          catId: 'codex-sol',
          executionId: 'inv-exact',
        },
      },
    };
    const backgroundState = useChatStore.getState().getThreadState(threadId);
    useActiveExecutionStore.setState({
      anchorThreadId: threadId,
      projectPath: '/test',
      executionsByKey: { [activeExecutionKey(execution)]: execution },
      hydration: 'error',
      hydrationError: 'offline',
    });
    useChatStore.setState({
      currentThreadId: 'default',
      threads: [
        {
          id: threadId,
          title: 'Canonical split',
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
        [threadId]: {
          ...backgroundState,
          hasActiveInvocation: true,
          activeInvocations: { 'inv-exact': { catId: 'codex-sol', mode: 'execute' } },
        },
      },
    });
    let releaseCancel: ((response: Response) => void) | undefined;
    const cancelResponse = new Promise<Response>((resolve) => {
      releaseCancel = resolve;
    });
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/cancel')) return cancelResponse;
      if (url.endsWith('/executions/active')) {
        return new Response(JSON.stringify({ projectPath: '/test', executions: [] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        React.createElement(SplitPaneView, {
          onSend: vi.fn(),
          onZoomToThread: vi.fn(),
        }),
      ),
    );

    const cancel = container.querySelector('[data-testid="banner-cancel-btn"]') as HTMLButtonElement | null;
    const actionCancel = Array.from(container.querySelectorAll('[aria-label="Stop generation"]')).find(
      (button) => button !== cancel,
    ) as HTMLButtonElement | undefined;
    expect(cancel).not.toBeNull();
    expect(actionCancel).toBeTruthy();
    expect(container.querySelector('[data-testid="active-invocation-banner"]')?.textContent).toContain(
      '状态暂不可核对',
    );
    await act(async () => {
      cancel?.click();
      actionCancel?.click();
      await Promise.resolve();
    });

    const exactCancelCalls = mocks.apiFetch.mock.calls.filter(([url]) => String(url).includes('/cancel'));
    expect(exactCancelCalls).toHaveLength(1);
    expect(Array.from(container.querySelectorAll('[aria-label="Stop generation"]'))).toSatisfy((buttons: Element[]) =>
      buttons.every((button) => (button as HTMLButtonElement).disabled),
    );
    expect(mocks.apiFetch).toHaveBeenCalledWith(`/api/threads/${threadId}/executions/live/inv-exact/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catId: 'codex-sol' }),
    });

    releaseCancel?.(new Response('{}', { status: 200 }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
