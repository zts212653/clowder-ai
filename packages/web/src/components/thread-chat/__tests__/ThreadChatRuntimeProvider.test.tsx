// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const socketState = vi.hoisted(() => ({
  callbacks: undefined as { onIndexEvent?: (event: string, data: Record<string, unknown>) => void } | undefined,
  connectionMounts: 0,
  foregroundThreadIds: [] as string[],
  activeThreadId: undefined as string | undefined,
  agentMessageInstance: undefined as symbol | undefined,
}));

vi.mock('@/hooks/useAgentMessages', async () => {
  const React = await import('react');
  return {
    useAgentMessages: () => {
      const instanceRef = React.useRef<symbol | null>(null);
      const handlersRef = React.useRef<{
        handleAgentMessage: ReturnType<typeof vi.fn>;
        resetRefs: ReturnType<typeof vi.fn>;
        resetTimeout: ReturnType<typeof vi.fn>;
        clearDoneTimeout: ReturnType<typeof vi.fn>;
      } | null>(null);
      instanceRef.current ??= Symbol('agent-message-instance');
      handlersRef.current ??= {
        handleAgentMessage: vi.fn(),
        resetRefs: vi.fn(),
        resetTimeout: vi.fn(),
        clearDoneTimeout: vi.fn(),
      };
      socketState.agentMessageInstance = instanceRef.current;
      return handlersRef.current;
    },
  };
});

vi.mock('@/hooks/useChatSocketCallbacks', () => ({
  useChatSocketCallbacks: (callbacks: { onIndexEvent?: (event: unknown) => void }) => callbacks,
}));

vi.mock('@/hooks/useSocket', async () => {
  const React = await import('react');
  return {
    useSocket: (
      callbacks: { onIndexEvent?: (event: string, data: Record<string, unknown>) => void },
      threadId?: string,
      threadIds?: string[],
    ) => {
      socketState.callbacks = callbacks;
      socketState.activeThreadId = threadId;
      socketState.foregroundThreadIds = threadIds ?? [];
      React.useEffect(() => {
        socketState.connectionMounts += 1;
      }, []);
      return { socketConnected: true };
    },
  };
});

vi.mock('@/utils/userId', () => ({ getUserId: () => 'user-1' }));
vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));

import {
  ThreadChatRuntimeProvider,
  type ThreadChatRuntimeRegistration,
  useThreadChatRuntime,
} from '../ThreadChatRuntimeProvider';

let container: HTMLDivElement;
let root: Root;

function Probe({
  threadIds,
  capture,
}: {
  threadIds: readonly string[];
  capture?: (runtime: ThreadChatRuntimeRegistration) => void;
}) {
  const runtime = useThreadChatRuntime(threadIds);
  capture?.(runtime);
  return null;
}

function Harness({ children, routeThreadId = 'thread-a' }: { children: ReactNode; routeThreadId?: string }) {
  return <ThreadChatRuntimeProvider routeThreadId={routeThreadId}>{children}</ThreadChatRuntimeProvider>;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  socketState.callbacks = undefined;
  socketState.connectionMounts = 0;
  socketState.foregroundThreadIds = [];
  socketState.activeThreadId = undefined;
  socketState.agentMessageInstance = undefined;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ThreadChatRuntimeProvider', () => {
  it('mounts one connection lifecycle and publishes the registered room union', async () => {
    let primaryRuntime: ThreadChatRuntimeRegistration | undefined;

    await act(async () => {
      root.render(
        <Harness>
          <Probe threadIds={['thread-a']} capture={(runtime) => (primaryRuntime = runtime)} />
          <Probe threadIds={['thread-a', 'thread-b']} />
        </Harness>,
      );
    });

    expect(socketState.connectionMounts).toBe(1);
    expect(socketState.foregroundThreadIds).toEqual(['thread-a', 'thread-b']);
    expect(primaryRuntime?.socketConnected).toBe(true);

    await act(async () => {
      root.render(
        <Harness>
          <Probe threadIds={['thread-b', 'thread-c']} capture={(runtime) => (primaryRuntime = runtime)} />
        </Harness>,
      );
    });

    expect(socketState.connectionMounts).toBe(1);
    expect(socketState.foregroundThreadIds).toEqual(['thread-b', 'thread-c']);
  });

  it('multicasts index events and lets each consumer clean up only its own handler', async () => {
    let runtime: ThreadChatRuntimeRegistration | undefined;
    await act(async () => {
      root.render(
        <Harness>
          <Probe threadIds={['thread-a']} capture={(value) => (runtime = value)} />
        </Harness>,
      );
    });

    const first = vi.fn();
    const second = vi.fn();
    const cleanupFirst = runtime?.registerIndexEventHandler(first);
    const cleanupSecond = runtime?.registerIndexEventHandler(second);

    socketState.callbacks?.onIndexEvent?.('index:progress', { kind: 'progress' });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    cleanupFirst?.();
    socketState.callbacks?.onIndexEvent?.('index:complete', { kind: 'done' });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);

    cleanupSecond?.();
    socketState.callbacks?.onIndexEvent?.('index:ignored', { kind: 'ignored' });
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('keeps route callback scope separate from consumer room registrations', async () => {
    await act(async () => {
      root.render(
        <Harness routeThreadId="route-thread">
          <Probe threadIds={['consumer-thread']} />
        </Harness>,
      );
    });

    expect(socketState.activeThreadId).toBe('route-thread');
    expect(socketState.foregroundThreadIds).toEqual(['consumer-thread']);
  });

  it('preserves the agent-message lifecycle while the active route changes', async () => {
    await act(async () => {
      root.render(
        <Harness routeThreadId="thread-a">
          <Probe threadIds={['thread-a']} />
        </Harness>,
      );
    });
    const initialInstance = socketState.agentMessageInstance;

    await act(async () => {
      root.render(
        <Harness routeThreadId="thread-b">
          <Probe threadIds={['thread-b']} />
        </Harness>,
      );
    });

    expect(socketState.agentMessageInstance).toBe(initialInstance);
    expect(socketState.connectionMounts).toBe(1);
  });
});
