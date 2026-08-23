import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_MODES } from '@/lib/workspace-modes';

const mocks = vi.hoisted(() => ({
  workspaceMode: 'dev',
  setWorkspaceMode: vi.fn(),
  setRightPanelOpen: vi.fn(),
  apiFetch: vi.fn(),
  openInvocationTrajectory: vi.fn(),
}));

vi.mock('../../ChatVoiceFeatureControls', () => ({
  ChatVoiceFeatureControls: () => <div data-testid="workspace-companion-controls">陪伴入口</div>,
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        workspaceMode: mocks.workspaceMode,
        setWorkspaceMode: mocks.setWorkspaceMode,
        setRightPanelOpen: mocks.setRightPanelOpen,
        threads: [{ id: 'thread-launcher', title: 'Launcher thread' }],
      }),
    {
      getState: () => ({
        workspaceMode: mocks.workspaceMode,
        setWorkspaceMode: mocks.setWorkspaceMode,
        setRightPanelOpen: mocks.setRightPanelOpen,
        threads: [{ id: 'thread-launcher', title: 'Launcher thread' }],
      }),
    },
  ),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

vi.mock('../trajectory/trajectory-navigation', () => ({
  openInvocationTrajectory: (...args: unknown[]) => mocks.openInvocationTrajectory(...args),
}));

vi.mock('@/components/story-player/TheaterReplayContent', () => ({
  TheaterReplayContent: ({ threadId }: { threadId: string }) => (
    <div data-testid="theater-replay-content">Replay {threadId}</div>
  ),
}));

import { TheaterReplayHost } from '../../story-player/TheaterReplayHost';
import { WorkspaceLauncher } from '../WorkspaceLauncher';

describe('F284 WorkspaceLauncher', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.workspaceMode = 'dev';
    mocks.setWorkspaceMode.mockReset();
    mocks.setRightPanelOpen.mockReset();
    mocks.apiFetch.mockReset();
    mocks.openInvocationTrajectory.mockReset();
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ invocations: [] }) });
    window.history.replaceState({}, '', '/thread/thread-launcher');
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

  async function renderLauncher() {
    await act(async () => {
      root.render(<WorkspaceLauncher />);
    });
  }

  function summary(
    invocationId: string,
    status: 'done' | 'error' | 'timeout',
    startedAt: number,
    threadId = 'thread-launcher',
  ) {
    return {
      invocationId,
      status,
      startedAt,
      threadId,
      sessionId: `session-${invocationId}`,
      sessionSeq: 0,
      sessionStatus: 'sealed',
      catId: 'codex-sol',
      durationMs: 10,
      eventCount: 1,
      statusEventCount: 0,
      toolUseCount: 0,
      toolResultCount: 0,
      messageCount: 1,
      errorCount: status === 'done' ? 0 : 1,
      toolNames: [],
      keyMessages: [],
    };
  }

  it('is the always-visible first screen rather than a second-step popover', async () => {
    await renderLauncher();

    expect(container.textContent).toContain('你想打开什么？');
    expect(container.querySelector('[data-testid="workspace-launcher-trigger"]')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-launcher-home"]')).not.toBeNull();
  });

  it('projects every canonical destination into human-readable groups', async () => {
    await renderLauncher();

    expect(container.textContent).toContain('现在要做什么');
    expect(container.textContent).toContain('组织工作');
    expect(container.textContent).toContain('回看与理解');

    for (const mode of WORKSPACE_MODES.filter((mode) => mode !== 'dev')) {
      expect(container.querySelector(`[data-testid="workspace-launcher-${mode}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-testid="workspace-launcher-dev"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-launcher-dev-files"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workspace-launcher-dev-browser"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workspace-launcher-status"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workspace-companion-controls"]')).not.toBeNull();
  });

  it('opens status and session diagnostics from the Launcher instead of permanent header chrome', async () => {
    const onOpenStatus = vi.fn();
    await act(async () => {
      root.render(<WorkspaceLauncher onOpenStatus={onOpenStatus} />);
    });

    const status = container.querySelector('[data-testid="workspace-launcher-status"]');
    await act(async () => {
      status?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpenStatus).toHaveBeenCalledOnce();
  });

  it('lets the panel width choose one or two columns instead of the viewport breakpoint', async () => {
    await renderLauncher();

    const grids = container.querySelectorAll<HTMLElement>('[data-testid="workspace-launcher-grid"]');
    expect(grids.length).toBeGreaterThan(0);
    for (const grid of grids) {
      expect(grid.dataset.layout).toBe('panel-auto-fit');
      expect(grid.className).not.toContain('xl:grid-cols-2');
    }
  });

  it('searches capability labels without adding permanent filters', async () => {
    await renderLauncher();
    const search = container.querySelector<HTMLInputElement>('[data-testid="workspace-launcher-search"]');

    await act(async () => {
      if (!search) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, '评估');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="workspace-launcher-eval"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workspace-launcher-dev"]')).toBeNull();
  });

  it('routes selection through the canonical store action', async () => {
    await renderLauncher();
    const item = container.querySelector('[data-testid="workspace-launcher-recall"]');

    await act(async () => {
      item?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.setWorkspaceMode).toHaveBeenCalledWith('recall');
  });

  it('routes development tools without restoring the permanent mode tab row', async () => {
    const onSelectDevSurface = vi.fn();
    await act(async () => {
      root.render(<WorkspaceLauncher onSelectDevSurface={onSelectDevSurface} />);
    });

    const browser = container.querySelector('[data-testid="workspace-launcher-dev-browser"]');
    await act(async () => {
      browser?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.setWorkspaceMode).toHaveBeenCalledWith('dev');
    expect(onSelectDevSurface).toHaveBeenCalledWith('browser');
    expect(container.querySelector('[data-testid="workspace-dev-mode-tabs"]')).toBeNull();
  });

  it('recalls the latest three invocations with abnormal ones first', async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        invocations: [
          summary('done-new', 'done', 400),
          summary('timeout-old', 'timeout', 100),
          summary('error-new', 'error', 300),
          summary('done-old', 'done', 50),
        ],
      }),
    });
    await act(async () => {
      root.render(<WorkspaceLauncher threadId="thread-launcher" />);
    });
    await act(async () => {});

    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-recent-invocation]'));
    expect(rows.map((row) => row.dataset.recentInvocation)).toEqual(['error-new', 'timeout-old', 'done-new']);
  });

  it('drops prior-thread recall cards while the next thread is still loading', async () => {
    let resolveThreadB: ((value: { ok: boolean; json: () => Promise<{ invocations: never[] }> }) => void) | undefined;
    const threadBResponse = new Promise<{ ok: boolean; json: () => Promise<{ invocations: never[] }> }>((resolve) => {
      resolveThreadB = resolve;
    });
    mocks.apiFetch.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes('/thread-a/')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ invocations: [summary('invocation-a', 'done', 100, 'thread-a')] }),
        });
      }
      if (url.includes('/thread-b/')) return threadBResponse;
      return Promise.resolve({ ok: true, json: async () => ({ invocations: [] }) });
    });

    await act(async () => {
      root.render(<WorkspaceLauncher threadId="thread-a" />);
    });
    await act(async () => {});
    const staleCard = container.querySelector<HTMLElement>('[data-recent-invocation="invocation-a"]');
    expect(staleCard).not.toBeNull();

    await act(async () => {
      root.render(<WorkspaceLauncher threadId="thread-b" />);
    });

    expect(container.querySelector('[data-recent-invocation="invocation-a"]')).toBeNull();
    await act(async () => {
      staleCard?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.openInvocationTrajectory).not.toHaveBeenCalled();

    await act(async () => {
      resolveThreadB?.({ ok: true, json: async () => ({ invocations: [] }) });
      await threadBResponse;
    });
  });

  it('opens the actual Theater host when the sidebar is not mounted', async () => {
    await act(async () => {
      root.render(
        <>
          <WorkspaceLauncher threadId="thread-launcher" />
          <TheaterReplayHost />
        </>,
      );
    });
    const theater = container.querySelector('[data-testid="workspace-launcher-theater"]');
    await act(async () => {
      theater?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="theater-replay-content"]')?.textContent).toContain(
      'thread-launcher',
    );
  });
});
