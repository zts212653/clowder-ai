import type { ActiveExecutionProjection, DeploymentWaitListResponse } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';

const mocks = vi.hoisted(() => ({
  projection: null as DeploymentWaitListResponse | null,
}));

vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
vi.mock('@/hooks/useActiveExecutionProjection', () => ({ cancelProjectedExecution: vi.fn() }));
vi.mock('@/hooks/useDeploymentWaitProjection', () => ({
  useDeploymentWaitProjection: () => ({
    projection: mocks.projection,
    hydration: 'ready',
    error: null,
    retry: vi.fn(),
  }),
}));

import { WorkspaceNowSurface } from '../WorkspaceNowSurface';

const running: ActiveExecutionProjection = {
  executionId: 'invocation-1',
  turnInvocationId: 'turn-1',
  threadId: 'thread-mixed',
  threadTitle: 'Mixed work',
  catId: 'codex-sol',
  kind: 'live_invocation',
  startedAt: 100,
  cancelability: { state: 'not_cancelable', reason: 'terminalizing' },
};

function deploymentProjection(): DeploymentWaitListResponse {
  return {
    projectPath: '/project/cafe',
    items: [
      {
        taskId: 'task-acceptance',
        threadId: 'thread-mixed',
        threadTitle: 'Mixed work',
        taskTitle: 'Verify the landed slice',
        ownerCatId: 'codex-sol',
        subjectRef: 'deployment:installation-1:runtime',
        deploymentId: 'runtime',
        generation: 1,
        createdAt: 1_000,
        nextStep: 'Check the daily runtime behavior.',
        condition: { kind: 'new_ready_boot', services: ['api', 'web'] },
        state: 'waiting_for_update',
      },
    ],
    candidate: null,
  };
}

describe('F323 mixed running and deployment-wait Workspace Home', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useActiveExecutionStore.getState().reset();
    mocks.projection = deploymentProjection();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('shows active development and a dormant acceptance wait for the same thread at once', async () => {
    const store = useActiveExecutionStore.getState();
    store.applySnapshot('thread-mixed', store.beginHydration('thread-mixed', '/project/cafe'), {
      projectPath: '/project/cafe',
      executions: [running],
    });
    await act(async () => root.render(<WorkspaceNowSurface />));

    expect(container.querySelectorAll('[data-testid="workspace-running-object"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="workspace-deployment-wait-item"]')).toHaveLength(1);
    expect(container.textContent).toContain('一件工作正在进行');
    expect(container.textContent).toContain('1 项待跟进');
    expect(container.textContent?.match(/等待更新/g)).toHaveLength(1);
    expect(container.textContent).not.toContain('工作已完成');
  });

  it('keeps a wait visible after the active invocation has ended', async () => {
    const store = useActiveExecutionStore.getState();
    store.applySnapshot('thread-mixed', store.beginHydration('thread-mixed', '/project/cafe'), {
      projectPath: '/project/cafe',
      executions: [],
    });
    await act(async () => root.render(<WorkspaceNowSurface />));

    expect(container.querySelector('[data-testid="workspace-developing"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="workspace-deployment-wait-item"]')).toHaveLength(1);
  });
});
