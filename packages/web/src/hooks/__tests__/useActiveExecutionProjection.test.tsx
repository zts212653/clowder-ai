import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    void path;
    void init;
    return new Response(JSON.stringify({ projectPath: '/project/cafe', executions: [] }), { status: 200 });
  }),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));

import { cancelProjectedExecution, useActiveExecutionProjection } from '../useActiveExecutionProjection';

function liveExecution(): ActiveExecutionProjection {
  return {
    executionId: 'inv-exact',
    threadId: 'thread-a',
    threadTitle: 'Thread A',
    catId: 'codex-sol',
    kind: 'live_invocation',
    startedAt: 1,
    cancelability: {
      state: 'cancelable',
      target: {
        kind: 'live_invocation',
        threadId: 'thread-a',
        catId: 'codex-sol',
        executionId: 'inv-exact',
      },
    },
  };
}

function Harness({ threadId, connected }: { threadId: string; connected: boolean | null }) {
  useActiveExecutionProjection(threadId, connected);
  return null;
}

describe('F295 canonical execution hydration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      void path;
      void init;
      return new Response(JSON.stringify({ projectPath: '/project/cafe', executions: [] }), { status: 200 });
    });
    useActiveExecutionStore.getState().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('hydrates on first mount, reconnect, navigation, and bounded cold-discovery polling', async () => {
    await act(async () => {
      root.render(<Harness threadId="thread-a" connected={false} />);
    });
    expect(mocks.apiFetch).toHaveBeenLastCalledWith('/api/threads/thread-a/executions/active', {
      signal: expect.any(AbortSignal),
    });

    await act(async () => {
      root.render(<Harness threadId="thread-a" connected />);
    });
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    expect(mocks.apiFetch).toHaveBeenCalledTimes(3);

    await act(async () => {
      root.render(<Harness threadId="thread-b" connected />);
    });
    expect(mocks.apiFetch).toHaveBeenLastCalledWith('/api/threads/thread-b/executions/active', {
      signal: expect.any(AbortSignal),
    });
  });

  it('restores a tracker-less scheduler provider from the canonical snapshot after a cold mount', async () => {
    const schedulerExecution: ActiveExecutionProjection = {
      executionId: 'inv-scheduler-process',
      threadId: 'thread-a',
      threadTitle: 'Thread A',
      catId: 'opus5',
      kind: 'live_invocation',
      startedAt: 450,
      cancelability: {
        state: 'cancelable',
        target: {
          kind: 'live_invocation',
          threadId: 'thread-a',
          catId: 'opus5',
          executionId: 'inv-scheduler-process',
        },
      },
    };
    mocks.apiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ projectPath: '/project/cafe', executions: [schedulerExecution] }), {
        status: 200,
      }),
    );

    await act(async () => {
      root.render(<Harness threadId="thread-a" connected={false} />);
    });

    expect(useActiveExecutionStore.getState().executionsByKey).toEqual({
      'live_invocation:inv-scheduler-process': schedulerExecution,
    });
  });

  it('treats an exact 409 retry as terminal convergence and refreshes the projection', async () => {
    const execution = liveExecution();
    const request = useActiveExecutionStore.getState().beginHydration('thread-a');
    useActiveExecutionStore.getState().applySnapshot('thread-a', request, {
      projectPath: '/project/cafe',
      executions: [execution],
    });
    mocks.apiFetch.mockImplementation(async (url: string) =>
      url.includes('/cancel')
        ? new Response(JSON.stringify({ error: 'already terminal' }), { status: 409 })
        : new Response(JSON.stringify({ projectPath: '/project/cafe', executions: [] }), { status: 200 }),
    );

    await expect(cancelProjectedExecution(execution)).resolves.toBeUndefined();

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/threads/thread-a/executions/live/inv-exact/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catId: 'codex-sol' }),
    });
    expect(useActiveExecutionStore.getState().executionsByKey).toEqual({});
    expect(useActiveExecutionStore.getState().cancelPendingByKey).toEqual({});
  });
});
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
