import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import type { LauncherWorkspaceSearch } from '@/components/workspace/WorkspaceLauncherSearch';
import { F307WorkspaceHomePage } from '../F307WorkspaceHomePage';
import { resolveFileTarget } from '../real-surface-adapters';

const mocks = vi.hoisted(() => ({
  setWorkspaceMode: vi.fn(),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: { setWorkspaceMode: typeof mocks.setWorkspaceMode }) => unknown) =>
    selector({ setWorkspaceMode: mocks.setWorkspaceMode }),
}));

vi.mock('@/components/workspace/WorkspaceNowSurface', () => ({
  WorkspaceNowSurface: () => <div data-testid="workspace-now-surface" />,
}));

vi.mock('@/components/ChatVoiceFeatureControls', () => ({
  ChatVoiceFeatureControls: () => null,
}));

vi.mock('@/components/workspace/RecentTrajectoryRecall', () => ({
  RecentTrajectoryRecall: () => null,
}));

vi.mock('@/components/workspace/WorkspaceLauncherSearch', () => ({
  WorkspaceLauncherSearch: ({ workspaceSearch }: { workspaceSearch?: LauncherWorkspaceSearch }) => (
    <button
      type="button"
      data-testid="mock-workspace-search-result"
      onClick={() => workspaceSearch?.onOpenResult('src/F307-search-result.ts', 120)}
    >
      Open search result
    </button>
  ),
}));

describe('F307 canonical Home destination admission', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSelectSurface: ReturnType<typeof vi.fn<(surface: WorkspaceSurfaceDescriptor) => void>>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.setWorkspaceMode.mockReset();
    onSelectSurface = vi.fn<(surface: WorkspaceSurfaceDescriptor) => void>();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderHome(
    worktreeId: string | null,
    worktreeLoading: boolean,
    worktreeError: string | null = null,
    workspaceSearch?: LauncherWorkspaceSearch,
  ) {
    await act(async () => {
      root.render(
        <F307WorkspaceHomePage
          threadId="thread-f307"
          defaultCatId="codex-sol"
          onSelectDevSurface={() => undefined}
          onSelectSurface={onSelectSurface}
          worktreeId={worktreeId}
          worktreeLoading={worktreeLoading}
          worktreeError={worktreeError}
          openFilePath={null}
          preview={{ path: '/' }}
          workspaceSearch={workspaceSearch}
        />,
      );
    });
  }

  it('keeps a Files click pending until discovery supplies the exact worktree owner', async () => {
    await renderHome(null, true);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="workspace-launcher-dev-files"]')?.click();
    });

    expect(onSelectSurface).not.toHaveBeenCalled();
    expect(container.textContent).toContain('正在读取工作区');

    await renderHome('worktree-a', false);

    expect(onSelectSurface).toHaveBeenCalledTimes(1);
    expect(onSelectSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'workspace:surface:files:worktree-a',
        objectRef: { kind: 'workspace-destination', id: 'surface:files' },
      }),
    );
  });

  it('settles a pending destination into a visible error when discovery finishes without an owner', async () => {
    await renderHome(null, true);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="workspace-launcher-dev-terminal"]')?.click();
    });

    await renderHome(null, false, '没有找到当前项目的工作区');

    expect(onSelectSurface).not.toHaveBeenCalled();
    expect(container.textContent).toContain('没有找到当前项目的工作区');
    expect(container.textContent).not.toContain('正在读取工作区');
  });

  it('opens Status as a Workbench surface without invoking the legacy full-host switch', async () => {
    await renderHome('worktree-a', false);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="workspace-launcher-status"]')?.click();
    });

    expect(onSelectSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'workspace:host:status',
        objectRef: { kind: 'workspace-destination', id: 'host:status' },
      }),
    );
  });

  it('preserves a Home content-result line in the persisted F307 file owner', async () => {
    const onOpenResult = vi.fn();
    await renderHome('worktree-a', false, null, {
      enabled: true,
      results: [],
      loading: false,
      error: null,
      onSearch: vi.fn(),
      onReset: vi.fn(),
      onOpenResult,
      onViewAll: vi.fn(),
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mock-workspace-search-result"]')?.click();
    });

    expect(onOpenResult).toHaveBeenCalledWith('src/F307-search-result.ts', 120);
    expect(onSelectSurface).toHaveBeenCalledTimes(1);
    expect(resolveFileTarget(onSelectSurface.mock.calls[0][0])).toEqual({
      worktreeId: 'worktree-a',
      path: 'src/F307-search-result.ts',
      scrollToLine: 120,
    });
  });

  it('shows one first-class capability evolution entry instead of dumping Program projections on Home', async () => {
    await renderHome('worktree-a', false);

    expect(container.textContent).toContain('能力进化');
    expect(container.textContent).not.toContain('Evolution Programs');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="workspace-launcher-capability-evolution"]')?.click();
    });

    expect(onSelectSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'workspace:capability-evolution',
        title: '能力进化',
        objectRef: { kind: 'workspace-destination', id: 'workspace:capability-evolution' },
        ownerStateRef: { owner: 'f311-capability-evolution-control', key: 'workspace' },
      }),
    );
  });
});
