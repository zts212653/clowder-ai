import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { F307WorkspaceHomePage } from '../F307WorkspaceHomePage';

const mocks = vi.hoisted(() => ({
  setWorkspaceMode: vi.fn(),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: { setWorkspaceMode: typeof mocks.setWorkspaceMode }) => unknown) =>
    selector({ setWorkspaceMode: mocks.setWorkspaceMode }),
}));
vi.mock('@/components/workspace/WorkspaceNowSurface', () => ({
  WorkspaceNowSurface: () => null,
}));
vi.mock('@/components/ChatVoiceFeatureControls', () => ({
  ChatVoiceFeatureControls: () => null,
}));
vi.mock('@/components/workspace/RecentTrajectoryRecall', () => ({
  RecentTrajectoryRecall: () => null,
}));

describe('F307 Home return search restoration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('restores the origin query into the real Launcher and replays its file results', async () => {
    const onSearch = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <F307WorkspaceHomePage
          threadId="thread-f307"
          defaultCatId="codex-sol"
          onSelectDevSurface={() => undefined}
          onSelectSurface={() => undefined}
          worktreeId="worktree-a"
          openFilePath={null}
          preview={{ path: '/' }}
          workspaceSearchQuery="canonical owner"
          workspaceSearch={{
            enabled: true,
            results: [
              {
                path: 'docs/canonical-owner.md',
                line: 12,
                content: 'canonical owner contract',
                contextBefore: '',
                contextAfter: '',
                matchType: 'content',
              },
            ],
            loading: false,
            error: null,
            onSearch,
            onReset: vi.fn(),
            onOpenResult: vi.fn(),
            onViewAll: vi.fn(),
          }}
        />,
      );
    });

    expect(container.querySelector<HTMLInputElement>('[data-testid="workspace-launcher-search"]')?.value).toBe(
      'canonical owner',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(onSearch).toHaveBeenCalledWith('canonical owner');
    expect(container.textContent).toContain('canonical-owner.md');
  });
});
