import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import type { CatStatusType } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ThreadExecutionBar } from '../ThreadExecutionBar';

function setActive(catId: string, status: CatStatusType) {
  const request = useActiveExecutionStore.getState().beginHydration('thread-a');
  useActiveExecutionStore.getState().applySnapshot('thread-a', request, {
    projectPath: '/project/cafe',
    executions: [
      {
        executionId: 'inv-a',
        threadId: 'thread-a',
        threadTitle: 'Alpha',
        catId,
        kind: 'live_invocation',
        startedAt: Date.now(),
        cancelability: {
          state: 'cancelable',
          target: { kind: 'live_invocation', threadId: 'thread-a', catId, executionId: 'inv-a' },
        },
      },
    ],
  });
  useChatStore.setState({
    currentThreadId: 'thread-a',
    activeInvocations: { 'inv-a': { catId, mode: 'execute', startedAt: 1000 } },
    hasActiveInvocation: true,
    catStatuses: { [catId]: status },
    catInvocations: {},
    threadStates: {},
  });
}

describe('ThreadExecutionBar Stop surface', () => {
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
    useActiveExecutionStore.getState().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each<CatStatusType>([
    'streaming',
    'suspected_stall',
  ])('keeps one exact Stop control and never exposes manual force reset for %s', (status) => {
    setActive('opus', status);
    act(() => root.render(React.createElement(ThreadExecutionBar, { threadId: 'thread-a' })));

    expect(container.querySelector('button[aria-label="Stop opus live_invocation inv-a"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="force-reset-entry"]')).toBeNull();
    expect(container.textContent).not.toContain('强制重置');
  });
});
