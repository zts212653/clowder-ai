/**
 * F322 original-B: the new shell (v2) says "who is running, for how long, how to stop" once, on the execution row above
 * the composer. The old "<cat>回复中 · <thread> · 实时回合" line at the top of the conversation is not rendered there;
 * the classic shell keeps it exactly as it was.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { SHELL_PRESENTATION_STORAGE_KEY, writeShellPresentation } from '../shell/shell-presentation';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) => (id === 'codex' ? { displayName: '缅因猫 (Codex)', catId: 'codex' } : null),
  }),
}));

const storeState: Record<string, unknown> = {
  targetCats: ['codex'],
  activeInvocations: {} as Record<string, { catId: string; mode: string }>,
  catStatuses: {} as Record<string, string>,
  catInvocations: {} as Record<string, unknown>,
  currentThreadId: 'thread-1',
};

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => (selector ? selector(storeState) : storeState),
    { getState: () => storeState },
  ),
}));

import { ThinkingIndicator } from '../ThinkingIndicator';

function seedExecution() {
  useActiveExecutionStore.getState().reset();
  const request = useActiveExecutionStore.getState().beginHydration('thread-1', '/project/cafe');
  useActiveExecutionStore.getState().applySnapshot('thread-1', request, {
    projectPath: '/project/cafe',
    executions: [
      {
        executionId: 'inv-codex',
        threadId: 'thread-1',
        threadTitle: 'Current work',
        catId: 'codex',
        kind: 'live_invocation',
        startedAt: 1000,
        cancelability: {
          state: 'cancelable',
          target: { kind: 'live_invocation', threadId: 'thread-1', catId: 'codex', executionId: 'inv-codex' },
        },
      },
    ],
  });
}

const STATES = {
  streaming: () => {
    storeState.catStatuses = { codex: 'streaming' };
  },
  spawning: () => {
    storeState.catStatuses = { codex: 'spawning' };
  },
  silent: () => {
    storeState.catStatuses = { codex: 'alive_but_silent' };
    storeState.catInvocations = {
      codex: {
        livenessWarning: {
          level: 'alive_but_silent',
          state: 'busy-silent',
          silenceDurationMs: 150_000,
          firstEventAt: 1,
          lastEventType: 'tool.started',
        },
      },
    };
  },
} as const;

describe('ThinkingIndicator: the line at the top of the conversation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    seedExecution();
    storeState.catStatuses = {};
    storeState.catInvocations = {};
    storeState.currentThreadId = 'thread-1';
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
    useActiveExecutionStore.getState().reset();
  });

  const render = () => act(() => root.render(<ThinkingIndicator threadId="thread-1" />));

  it.each(Object.keys(STATES) as (keyof typeof STATES)[])('classic, %s: the line is rendered (unchanged)', (state) => {
    STATES[state]();
    render();
    expect(container.textContent).not.toBe('');
  });

  it('classic, streaming: it says who is replying, in which thread', () => {
    STATES.streaming();
    render();
    expect(container.textContent).toContain('回复中');
    expect(container.textContent).toContain('Current work');
  });

  it.each(Object.keys(STATES) as (keyof typeof STATES)[])('v2, %s: nothing is rendered — the row says it', (state) => {
    act(() => writeShellPresentation('v2'));
    STATES[state]();
    render();
    expect(container.innerHTML).toBe('');
  });

  it('switching the shell swaps it live in both directions', () => {
    STATES.streaming();
    render();
    expect(container.textContent).not.toBe('');
    act(() => writeShellPresentation('v2'));
    expect(container.innerHTML).toBe('');
    act(() => writeShellPresentation('classic'));
    expect(container.textContent).not.toBe('');
  });
});
