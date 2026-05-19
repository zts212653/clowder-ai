/**
 * F194 Phase Z10 AC-Z28 — 砚砚 R1 P1: server-idle truth must win the race.
 *
 * Bug in initial Z10: IDB restore only skipped when `currentState.hasActiveInvocation === true`.
 * If server is idle, fetchQueue clears active state first → store becomes `hasActive=false` →
 * IDB restore later sees store=idle + snapshot=active → wrongly resurrects stale active.
 * Reverse race: server confirms idle, but UI flickers back to "running".
 *
 * Fix: track which AbortController has had a successful fetchQueue (active OR idle) in a
 * WeakSet. IDB restore checks this set — skip if fetchQueue already completed.
 */
import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { _resetDBForTest, saveThreadActiveState } from '@/utils/offline-store';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

function HookHost({ threadId }: { threadId: string }) {
  useChatHistory(threadId);
  return null;
}

describe('F194 Phase Z10 AC-Z28 — server-idle wins reverse race (砚砚 R1 P1)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(async () => {
    await _resetDBForTest();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    useChatStore.setState({
      messages: [],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: true,
      hasActiveInvocation: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      currentGame: null,
      activeInvocations: {},

      threadStates: {},
      currentThreadId: 'thread-z10',
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
      queue: [],
      queuePaused: false,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    apiFetchMock.mockReset();
  });

  it('server says idle + IDB has stale active → store stays idle (IDB restore must NOT resurrect)', async () => {
    // Pre-condition: IDB has a stale "active" snapshot from previous session
    await saveThreadActiveState('thread-z10', {
      hasActiveInvocation: true,
      activeInvocations: {
        'stale-inv': { catId: 'opus-47', mode: 'execute', startedAt: 1000 },
      },
    });

    // Server `/queue` returns idle (no active invocations) — simulates 5s-later refresh
    // after the cat already finished.
    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(
          new Response(JSON.stringify({ queue: [], paused: false, activeInvocations: [] }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], hasMore: false, tasks: [] }), { status: 200 }),
      );
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-z10' }));
    });

    // Settle async work: fetchQueue + IDB restore + bootstrap
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    const state = useChatStore.getState();
    const threadState = state.threadStates['thread-z10'];

    // Server truth wins — IDB stale active must NOT be restored after server says idle.
    expect(state.hasActiveInvocation).toBe(false);
    expect(threadState?.hasActiveInvocation ?? false).toBe(false);
    expect(Object.keys(state.activeInvocations)).toEqual([]);
    expect(Object.keys(threadState?.activeInvocations ?? {})).toEqual([]);
  });

  it('server says active + IDB has stale idle → store reflects server active (control: no regression on Z10 main flow)', async () => {
    await saveThreadActiveState('thread-z10', {
      hasActiveInvocation: false,
      activeInvocations: {},
    });

    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              queue: [],
              paused: false,
              activeInvocations: [{ catId: 'codex', startedAt: 2000 }],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], hasMore: false, tasks: [] }), { status: 200 }),
      );
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-z10' }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    const threadState = useChatStore.getState().threadStates['thread-z10'];
    expect(threadState?.hasActiveInvocation).toBe(true);
  });
});
