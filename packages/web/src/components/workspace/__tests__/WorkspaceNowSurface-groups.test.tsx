import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';

vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
vi.mock('@/hooks/useActiveExecutionProjection', () => ({ cancelProjectedExecution: vi.fn() }));

import { cancelProjectedExecution } from '@/hooks/useActiveExecutionProjection';
import { WorkspaceNowSurface } from '../WorkspaceNowSurface';

function live(catId = 'codex-sol', threadId = 'thread-a', executionId = 'parent-a'): ActiveExecutionProjection {
  return {
    kind: 'live_invocation',
    catId,
    threadId,
    threadTitle: threadId,
    executionId,
    turnInvocationId: `child-${executionId}-${catId}`,
    startedAt: 100,
    cancelability: { state: 'cancelable', target: { kind: 'live_invocation', threadId, catId, executionId } },
  };
}

function command(executionId = 'hold-1'): ActiveExecutionProjection {
  return {
    kind: 'managed_command',
    catId: 'codex-sol',
    threadId: 'thread-a',
    threadTitle: 'thread-a',
    executionId,
    activity: 'test',
    startedAt: 200,
    cancelability: { state: 'cancelable', target: { kind: 'managed_command', taskId: executionId } },
  };
}

function hydrate(executions: ActiveExecutionProjection[]) {
  const store = useActiveExecutionStore.getState();
  store.applySnapshot('thread-a', store.beginHydration('thread-a', '/project'), {
    projectPath: '/project',
    executions,
  });
}

describe('Workspace running work counts cat/thread work, retaining exact activities', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useActiveExecutionStore.getState().reset();
    vi.mocked(cancelProjectedExecution).mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('counts the same cat/thread live turn and command once while preserving each action', async () => {
    const turn = live();
    const task = command();
    const onSelect = vi.fn();
    hydrate([turn, task]);
    await act(async () => root.render(<WorkspaceNowSurface onSelectExecution={onSelect} />));

    expect(container.querySelectorAll('[data-testid="workspace-running-object"]')).toHaveLength(1);
    expect(container.querySelector('h2')?.textContent).toBe('一件工作正在进行');
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/thread/thread-a');
    expect(container.textContent).toContain('回复中');
    expect(container.textContent).toContain('后台 · 测试');
    const details = container.querySelector<HTMLButtonElement>('[data-testid="workspace-open-running-object"]');
    act(() => details?.click());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(turn);

    const stops = container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Stop "]');
    expect(stops).toHaveLength(2);
    await act(async () => {
      stops[0]?.click();
      stops[1]?.click();
    });
    expect(vi.mocked(cancelProjectedExecution).mock.calls.map(([execution]) => execution)).toEqual([turn, task]);
    expect(Object.keys(useActiveExecutionStore.getState().executionsByKey)).toEqual([
      activeExecutionKey(turn),
      activeExecutionKey(task),
    ]);
  });

  it('keeps a stable work row while live and background executions finish independently', async () => {
    const turn = live();
    const task = command();
    hydrate([turn, task]);
    await act(async () => root.render(<WorkspaceNowSurface onSelectExecution={vi.fn()} />));
    const row = container.querySelector('[data-testid="workspace-running-object"]');

    await act(async () => hydrate([task]));
    expect(container.querySelector('[data-testid="workspace-running-object"]')).toBe(row);
    expect(container.querySelector('h2')?.textContent).toBe('一件工作正在进行');
    expect(container.textContent).toContain('等待后台');
    expect(container.textContent).not.toContain('回复中');
    expect(container.querySelector('[data-testid="workspace-open-running-object"]')).toBeNull();
    expect(container.querySelectorAll('button[aria-label^="Stop "]')).toHaveLength(1);

    await act(async () => hydrate([turn, task]));
    await act(async () => hydrate([turn]));
    expect(container.querySelector('[data-testid="workspace-running-object"]')).toBe(row);
    expect(container.querySelector('[data-testid="workspace-open-running-object"]')).not.toBeNull();
    expect(container.textContent).not.toContain('等待后台');
    await act(async () => hydrate([]));
    expect(container.textContent).toBe('');
  });

  it('preserves parallel cats and the same cat in other threads, without losing multiple commands', async () => {
    hydrate([live(), command(), command('hold-2'), live('codex-sol', 'thread-b'), live('fable5')]);
    await act(async () => root.render(<WorkspaceNowSurface onSelectExecution={vi.fn()} />));
    expect(container.querySelectorAll('[data-testid="workspace-running-object"]')).toHaveLength(3);
    expect(container.querySelector('h2')?.textContent).toBe('3 件工作正在进行');
    expect(container.querySelectorAll('button[aria-label^="Stop "]')).toHaveLength(5);
    expect(container.querySelectorAll('[data-testid="workspace-open-running-object"]')).toHaveLength(3);
    expect(container.querySelectorAll('a')).toHaveLength(3);
  });

  it('does not make a foreign or unresolved execution cancelable by grouping it with owned work', async () => {
    const foreign = { ...command(), cancelability: { state: 'not_cancelable', reason: 'foreign_principal' } } as const;
    const unresolved = { ...live(), turnInvocationId: undefined };
    hydrate([unresolved, foreign]);
    await act(async () => root.render(<WorkspaceNowSurface onSelectExecution={vi.fn()} />));
    expect(container.querySelectorAll('[data-testid="workspace-running-object"]')).toHaveLength(1);
    expect(container.querySelectorAll('button[aria-label^="Stop "]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="workspace-open-running-object"]')).toBeNull();
    expect(container.textContent).toContain('你不是发起方');
  });
});
