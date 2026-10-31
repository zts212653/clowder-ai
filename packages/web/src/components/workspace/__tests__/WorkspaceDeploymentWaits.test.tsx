import type { DeploymentWaitItemProjection, DeploymentWaitListResponse } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (catId: string) =>
      catId === 'codex-sol' ? { displayName: '砚砚' } : catId === 'kimi' ? { displayName: '墨墨' } : undefined,
  }),
}));

import { WorkspaceDeploymentWaits } from '../WorkspaceDeploymentWaits';

const REVISION = 'a'.repeat(40);
const CANDIDATE = 'b'.repeat(40);

function item(
  taskId: string,
  state: DeploymentWaitItemProjection['state'],
  overrides: Partial<DeploymentWaitItemProjection> = {},
): DeploymentWaitItemProjection {
  return {
    taskId,
    threadId: `thread-${taskId}`,
    threadTitle: `Thread ${taskId}`,
    taskTitle: `Verify ${taskId}`,
    ownerCatId: taskId === 'ready' ? 'kimi' : 'codex-sol',
    sourceMessageId: `message-${taskId}`,
    subjectRef: 'deployment:installation-1:runtime',
    deploymentId: 'runtime',
    generation: 1,
    createdAt: Date.UTC(2026, 8, 27, 10),
    nextStep: `Run ${taskId} acceptance`,
    condition: { kind: 'revision_included', revision: REVISION, services: ['api', 'web'] },
    state,
    ...overrides,
  };
}

function projection(items: DeploymentWaitItemProjection[]): DeploymentWaitListResponse {
  return {
    projectPath: '/project/cafe',
    items,
    candidate: {
      revision: CANDIDATE,
      observedAt: Date.UTC(2026, 8, 27, 11),
      satisfiableCount: 2,
      unknownCount: 1,
    },
  };
}

describe('F323 Workspace deployment waits real shell', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('separates waiting and ready-to-return items while keeping source and next action visible', async () => {
    const data = projection([
      item('waiting', 'waiting_for_update'),
      item('unknown', 'unknown', { stateReason: 'deployment_evidence_unavailable' }),
      item('ready', 'ready_to_return', { delivery: 'pending', matchedAt: Date.UTC(2026, 8, 27, 11) }),
    ]);
    await act(async () => {
      root.render(
        <WorkspaceDeploymentWaits
          projection={data}
          hydration="ready"
          onRetry={vi.fn()}
          now={Date.UTC(2026, 8, 27, 12)}
        />,
      );
    });

    expect(container.querySelectorAll('[data-testid="workspace-deployment-wait-item"]')).toHaveLength(3);
    expect(container.textContent).toContain('3 项待跟进');
    expect([...container.querySelectorAll('h3')].map((heading) => heading.textContent)).toEqual([
      '等待更新 · 1',
      '暂不能判定 · 1',
      '可以接回 · 1',
    ]);
    expect(container.textContent?.match(/等待更新/g)).toHaveLength(1);
    expect(container.textContent?.match(/可以接回/g)).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid^="deployment-wait-state-"]')).toHaveLength(0);
    expect(container.textContent).toContain(`候选 ${CANDIDATE.slice(0, 8)}`);
    expect(container.textContent).toContain('观察于 1 小时前');
    expect(container.textContent).toContain('预计满足 2 项');
    expect(container.textContent).toContain('另有 1 项证据待确认');
    expect(container.textContent).toContain('砚砚');
    expect(container.textContent).toContain('墨墨');
    expect(container.textContent).toContain(`包含 ${REVISION.slice(0, 8)}`);
    expect(container.textContent).toContain('Run waiting acceptance');
    expect(container.textContent).toContain('运行证据暂不可用');
    expect(container.querySelector('a[href="/thread/thread-ready"]')).not.toBeNull();
    expect(container.querySelector('a[href="/thread/thread-ready"]')?.closest('article')?.textContent).toContain(
      '已等待 1 小时',
    );
  });

  it('shows an honest zero state after hydration instead of disappearing', async () => {
    await act(async () => {
      root.render(
        <WorkspaceDeploymentWaits
          projection={{ projectPath: '/project/cafe', items: [], candidate: null }}
          hydration="ready"
          onRetry={vi.fn()}
          now={Date.UTC(2026, 8, 27, 12)}
        />,
      );
    });

    expect(container.textContent).toContain('暂无待跟进事项');
    expect(container.textContent).toContain('猫会在原任务里登记');
    expect(container.querySelector('[data-testid="workspace-deployment-waits"]')).not.toBeNull();
  });

  it('keeps the last verified rows on a read error and offers an explicit retry', async () => {
    const retry = vi.fn();
    await act(async () => {
      root.render(
        <WorkspaceDeploymentWaits
          projection={projection([item('waiting', 'waiting_for_update')])}
          hydration="error"
          onRetry={retry}
          now={Date.UTC(2026, 8, 27, 12)}
        />,
      );
    });

    expect(container.querySelectorAll('[data-testid="workspace-deployment-wait-item"]')).toHaveLength(1);
    expect(container.textContent).toContain('最近一次已验证清单');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="deployment-waits-retry"]')?.click(),
    );
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
