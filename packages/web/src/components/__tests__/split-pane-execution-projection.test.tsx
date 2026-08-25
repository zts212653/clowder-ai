import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import type { Thread } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';
import { SplitPaneView } from '../SplitPaneView';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => new Response('{}', { status: 200 })),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [],
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
  }),
}));

const ROUTE_THREAD_ID = 'split-route-thread';
const SELECTED_THREAD_ID = 'split-selected-thread';

function thread(id: string, projectPath: string): Thread {
  return {
    id,
    title: id,
    projectPath,
    createdBy: 'test-user',
    participants: [],
    lastActiveAt: 1,
    createdAt: 1,
  };
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('split-pane canonical execution projection', () => {
  const originalState = useChatStore.getState();
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useActiveExecutionStore.getState().reset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useChatStore.setState({
      currentThreadId: originalState.currentThreadId,
      threads: originalState.threads,
      splitPaneThreadIds: originalState.splitPaneThreadIds,
      splitPaneTargetId: originalState.splitPaneTargetId,
      threadStates: originalState.threadStates,
    });
    useActiveExecutionStore.getState().reset();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function renderScenario({
    snapshotProject,
    selectedProject,
    hydration,
  }: {
    snapshotProject: string;
    selectedProject: string;
    hydration: 'ready' | 'error';
  }): void {
    const selectedState = useChatStore.getState().getThreadState(SELECTED_THREAD_ID);
    useActiveExecutionStore.setState({
      anchorThreadId: ROUTE_THREAD_ID,
      projectPath: snapshotProject,
      executionsByKey: {},
      hydration,
      hydrationError: hydration === 'error' ? 'offline' : null,
    });
    useChatStore.setState({
      currentThreadId: ROUTE_THREAD_ID,
      threads: [thread(ROUTE_THREAD_ID, snapshotProject), thread(SELECTED_THREAD_ID, selectedProject)],
      splitPaneThreadIds: [ROUTE_THREAD_ID, SELECTED_THREAD_ID],
      splitPaneTargetId: SELECTED_THREAD_ID,
      threadStates: {
        [SELECTED_THREAD_ID]: {
          ...selectedState,
          hasActiveInvocation: true,
          activeInvocations: { 'stale-selected': { catId: 'codex-sol', mode: 'execute' } },
        },
      },
    });
    act(() =>
      root.render(
        React.createElement(SplitPaneView, {
          onSend: vi.fn(),
          onZoomToThread: vi.fn(),
        }),
      ),
    );
  }

  it('lets a same-project ready snapshot clear stale liveness for selected thread B', () => {
    renderScenario({ snapshotProject: '/same-project', selectedProject: '/same-project', hydration: 'ready' });

    expect(container.querySelector('[data-testid="active-invocation-banner"]')).toBeNull();
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('textarea missing');
    act(() => setTextareaValue(textarea, 'new work'));
    expect(container.querySelector('[aria-label="排队发送"]')).toBeNull();
    expect(container.querySelector('[aria-label="Send message"]')).not.toBeNull();
  });

  it('keeps stale liveness fail-closed outside the hydrated project', () => {
    renderScenario({ snapshotProject: '/project-a', selectedProject: '/project-b', hydration: 'ready' });

    expect(container.querySelector('[data-testid="active-invocation-banner"]')?.textContent).toContain(
      '正在确认运行状态',
    );
    expect((container.querySelector('[aria-label="Stop generation"]') as HTMLButtonElement | null)?.disabled).toBe(
      true,
    );
  });

  it('marks same-project stale liveness unverifiable when hydration fails', () => {
    renderScenario({ snapshotProject: '/same-project', selectedProject: '/same-project', hydration: 'error' });

    expect(container.querySelector('[data-testid="active-invocation-banner"]')?.textContent).toContain(
      '运行状态暂不可核对',
    );
    expect((container.querySelector('[aria-label="Stop generation"]') as HTMLButtonElement | null)?.disabled).toBe(
      true,
    );
  });
});
