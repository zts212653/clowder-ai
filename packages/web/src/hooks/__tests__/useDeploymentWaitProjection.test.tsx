import type { DeploymentWaitListResponse } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));

import { type DeploymentWaitProjectionView, useDeploymentWaitProjection } from '../useDeploymentWaitProjection';

function response(projectPath: string, taskId: string): DeploymentWaitListResponse {
  return {
    projectPath,
    items: [
      {
        taskId,
        threadId: `thread-${taskId}`,
        threadTitle: taskId,
        taskTitle: taskId,
        ownerCatId: 'codex-sol',
        subjectRef: 'deployment:installation-1:runtime',
        deploymentId: 'runtime',
        generation: 1,
        createdAt: 1,
        nextStep: 'Verify',
        condition: { kind: 'new_ready_boot', services: ['api'] },
        state: 'waiting_for_update',
      },
    ],
    candidate: null,
  };
}

let latest: DeploymentWaitProjectionView;
function Harness({ projectPath }: { projectPath: string | null }) {
  latest = useDeploymentWaitProjection(projectPath);
  return null;
}

describe('F323 deployment wait projection hydration', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockResolvedValue(Response.json(response('/project/a', 'task-a')));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('hydrates and polls the exact project resource', async () => {
    await act(async () => root.render(<Harness projectPath="/project/a" />));

    expect(mocks.apiFetch).toHaveBeenLastCalledWith('/api/runtime-deployment/waits?projectPath=%2Fproject%2Fa', {
      signal: expect.any(AbortSignal),
    });
    expect(latest.hydration).toBe('ready');
    expect(latest.projection?.items[0].taskId).toBe('task-a');

    await act(async () => vi.advanceTimersByTime(4_000));
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the last verified snapshot on an error and retries explicitly', async () => {
    await act(async () => root.render(<Harness projectPath="/project/a" />));
    mocks.apiFetch.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await act(async () => latest.retry());

    expect(latest.hydration).toBe('error');
    expect(latest.projection?.items[0].taskId).toBe('task-a');

    mocks.apiFetch.mockResolvedValueOnce(Response.json(response('/project/a', 'task-b')));
    await act(async () => latest.retry());
    expect(latest.hydration).toBe('ready');
    expect(latest.projection?.items[0].taskId).toBe('task-b');
  });

  it('clears a stale project and ignores its late response', async () => {
    let resolveA!: (value: Response) => void;
    mocks.apiFetch
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json(response('/project/b', 'task-b')));

    await act(async () => root.render(<Harness projectPath="/project/a" />));
    await act(async () => root.render(<Harness projectPath="/project/b" />));
    await act(async () => resolveA(Response.json(response('/project/a', 'task-a'))));

    expect(latest.hydration).toBe('ready');
    expect(latest.projection?.projectPath).toBe('/project/b');
    expect(latest.projection?.items[0].taskId).toBe('task-b');
  });
});
