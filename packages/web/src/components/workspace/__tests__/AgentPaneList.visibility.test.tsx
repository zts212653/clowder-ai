import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSurfaceVisibilityProvider } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { AgentPaneList } from '../AgentPaneList';

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

function paneResponse(invocationId: string, paneId: string, status: 'running' | 'done' | 'crashed') {
  return Response.json([{ invocationId, paneId, status, startedAt: 1 }]);
}

describe('AgentPaneList retained-surface visibility', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([{ invocationId: 'invocation-one', paneId: 'pane-one', status: 'running', startedAt: 1 }]),
        { status: 200 },
      ),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(visible: boolean, worktreeId = 'worktree-a') {
    await act(async () => {
      root.render(
        <WorkspaceSurfaceVisibilityProvider visible={visible}>
          <AgentPaneList worktreeId={worktreeId} onSelectPane={() => undefined} />
        </WorkspaceSurfaceVisibilityProvider>,
      );
      await Promise.resolve();
    });
  }

  it('does zero hidden GETs, catches up on return, and preserves the rendered pane', async () => {
    await render(false);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(apiFetchMock).not.toHaveBeenCalled();

    await render(true);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const pane = container.querySelector('button');
    expect(pane?.textContent).toContain('invocati');

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(apiFetchMock).toHaveBeenCalledTimes(13);

    await render(false);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(apiFetchMock).toHaveBeenCalledTimes(13);
    expect(container.querySelector('button')).toBe(pane);

    await render(true);
    expect(apiFetchMock).toHaveBeenCalledTimes(14);
    expect(container.querySelector('button')).toBe(pane);
  });

  it('rejects a pre-hide response that settles after the return catch-up', async () => {
    let resolveBeforeHide!: (response: Response) => void;
    let resolveAfterReturn!: (response: Response) => void;
    apiFetchMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveBeforeHide = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAfterReturn = resolve;
          }),
      );

    await render(true);
    await render(false);
    await render(true);
    await act(async () => resolveAfterReturn(paneResponse('bbbbbbbb-current', 'pane-b', 'running')));
    expect(container.textContent).toContain('bbbbbbbb');
    expect(container.textContent).toContain('Running');

    await act(async () => resolveBeforeHide(paneResponse('aaaaaaaa-stale', 'pane-a', 'done')));
    expect(container.textContent).toContain('bbbbbbbb');
    expect(container.textContent).not.toContain('aaaaaaaa');
    expect(container.textContent).not.toContain('Done');
  });

  it('clears the previous worktree and rejects its late response', async () => {
    let resolveOldPoll!: (response: Response) => void;
    let resolveWorktreeB!: (response: Response) => void;
    apiFetchMock
      .mockResolvedValueOnce(paneResponse('aaaaaaaa-old', 'pane-a', 'done'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldPoll = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveWorktreeB = resolve;
          }),
      );

    await render(true, 'worktree-a');
    expect(container.textContent).toContain('aaaaaaaa');
    await act(async () => vi.advanceTimersByTimeAsync(5000));

    await render(true, 'worktree-b');
    expect(container.textContent).not.toContain('aaaaaaaa');
    await act(async () => resolveWorktreeB(paneResponse('bbbbbbbb-current', 'pane-b', 'running')));
    expect(container.textContent).toContain('bbbbbbbb');
    await act(async () => resolveOldPoll(paneResponse('aaaaaaaa-stale', 'pane-a', 'done')));
    expect(container.textContent).toContain('bbbbbbbb');
    expect(container.textContent).not.toContain('aaaaaaaa');
  });
});
