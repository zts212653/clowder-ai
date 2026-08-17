import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (catId: string) =>
      catId === 'codex-sol' ? { displayName: '砚砚' } : catId === 'kimi' ? { displayName: '墨墨' } : undefined,
  }),
}));

import { WorkspaceNowSurface } from '../WorkspaceNowSurface';

describe('F284 WorkspaceNowSurface', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders nothing when there is no active object', async () => {
    await act(async () => {
      root.render(<WorkspaceNowSurface />);
    });

    expect(container.querySelector('[data-testid="workspace-quiet"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="workspace-running-object"]')).toHaveLength(0);
    expect(container.textContent).toBe('');
  });

  it('renders exactly the real running objects instead of a permanent tool inventory', async () => {
    const request = useActiveExecutionStore.getState().beginHydration('thread-a');
    useActiveExecutionStore.getState().applySnapshot('thread-a', request, {
      projectPath: '/project/cafe',
      executions: [
        {
          executionId: 'inv-1',
          threadId: 'thread-a',
          threadTitle: 'Foreground thread',
          catId: 'codex-sol',
          kind: 'live_invocation',
          startedAt: 1,
          cancelability: {
            state: 'cancelable',
            target: {
              kind: 'live_invocation',
              threadId: 'thread-a',
              catId: 'codex-sol',
              executionId: 'inv-1',
            },
          },
        },
        {
          executionId: 'hold-ball-2',
          threadId: 'thread-b',
          threadTitle: 'Background thread',
          catId: 'kimi',
          kind: 'managed_command',
          startedAt: 2,
          cancelability: {
            state: 'cancelable',
            target: { kind: 'managed_command', taskId: 'hold-ball-2' },
          },
        },
      ],
    });
    await act(async () => {
      root.render(<WorkspaceNowSurface repository={{ name: 'cat-cafe', branch: 'feat/f284-ux-implementation' }} />);
    });

    expect(container.querySelector('[data-testid="workspace-developing"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="workspace-running-object"]')).toHaveLength(2);
    expect(container.textContent).toContain('cat-cafe');
    expect(container.textContent).toContain('feat/f284-ux-implementation');
    expect(container.textContent).toContain('Foreground thread · 实时回合');
    expect(container.textContent).toContain('Background thread · 托管命令');
  });

  it('shows an explicit reason when canonical truth cannot offer a safe cancel target', async () => {
    const request = useActiveExecutionStore.getState().beginHydration('thread-a');
    useActiveExecutionStore.getState().applySnapshot('thread-a', request, {
      projectPath: '/project/cafe',
      executions: [
        {
          executionId: 'unresolved:thread-a:kimi:3',
          threadId: 'thread-a',
          threadTitle: 'Recovered work',
          catId: 'kimi',
          kind: 'live_invocation',
          startedAt: 3,
          cancelability: { state: 'not_cancelable', reason: 'control_plane_unavailable' },
        },
      ],
    });

    await act(async () => root.render(<WorkspaceNowSurface />));

    expect(container.textContent).toContain('控制面暂不可用，无法安全停止');
    expect(container.querySelector('[data-testid="execution-not-cancelable"]')).not.toBeNull();
  });
});
