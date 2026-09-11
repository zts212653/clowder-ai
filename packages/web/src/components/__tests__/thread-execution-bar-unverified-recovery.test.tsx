import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { ThreadExecutionBar } from '../ThreadExecutionBar';

describe('ThreadExecutionBar legacy-only recovery', () => {
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
    useChatStore.setState({
      currentThreadId: 'thread-a',
      activeInvocations: { 'inv-a': { catId: 'opus', mode: 'execute', startedAt: 1000 } },
      hasActiveInvocation: true,
      catStatuses: { opus: 'streaming' },
      catInvocations: {},
      threadStates: {},
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('does not teach a second recovery action when canonical execution chrome is empty', () => {
    act(() => root.render(React.createElement(ThreadExecutionBar, { threadId: 'thread-a' })));

    expect(container.textContent).toBe('');
    expect(container.querySelector('[data-testid="execution-unverified-recovery"]')).toBeNull();
    expect(container.querySelector('[data-testid="force-reset-entry"]')).toBeNull();
  });
});
