import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { F307WorkspaceHomePage } from '../F307WorkspaceHomePage';
import { artifactObjectId } from '../real-surface-adapters';

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({ threads: [], setWorkspaceMode: vi.fn() }),
}));
vi.mock('@/components/workspace/WorkspaceNowSurface', () => ({ WorkspaceNowSurface: () => null }));
vi.mock('@/components/ChatVoiceFeatureControls', () => ({ ChatVoiceFeatureControls: () => null }));
vi.mock('@/components/workspace/RecentTrajectoryRecall', () => ({ RecentTrajectoryRecall: () => null }));
vi.mock('@/components/workspace-home/HomeLiveCard', () => ({ HomeLiveCard: () => null }));
vi.mock('@/components/workspace-home/HomeWaitCard', () => ({ HomeWaitCard: () => null }));

describe('canonical Home card return geometry', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  function getElement<T extends HTMLElement>(selector: string): T {
    const element = container.querySelector<T>(selector);
    if (!element) throw new Error(`Missing Home control: ${selector}`);
    return element;
  }
  async function renderHome(overrides: Partial<ComponentProps<typeof F307WorkspaceHomePage>> = {}) {
    await act(async () =>
      root.render(
        <F307WorkspaceHomePage
          defaultCatId="codex61-sol"
          onSelectDevSurface={() => undefined}
          onSelectSurface={() => undefined}
          worktreeId="work"
          openFilePath={null}
          preview={{ path: '/' }}
          {...overrides}
        />,
      ),
    );
  }
  it('restores the exact Home card after asynchronous insertion, follows growth, then releases on input', async () => {
    let resize: (() => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    const artifactId = artifactObjectId({
      type: 'file',
      name: 'guide.md',
      catId: null,
      sourceMessageId: null,
      createdAt: 17,
      ref: 'guide.md',
    });
    const returnOrigin = {
      kind: 'workspace-home-artifact' as const,
      threadId: 'thread-card',
      artifactId,
      viewportOffsetPx: 84,
    };
    await renderHome({ threadId: 'thread-card', workspaceArtifactReturnOrigin: returnOrigin });
    const home = getElement<HTMLElement>('[data-testid="f307-workspace-home-page"]');
    vi.spyOn(home, 'getBoundingClientRect').mockReturnValue({ top: 10 } as DOMRect);
    const card = document.createElement('button');
    card.dataset.homeArtifactId = artifactId;
    let contentTop = 500;
    vi.spyOn(card, 'getBoundingClientRect').mockImplementation(
      () => ({ top: 10 + contentTop - home.scrollTop, height: 30 }) as DOMRect,
    );
    await act(async () => {
      home.querySelector('[data-workspace-home-content]')?.append(card);
      resize?.();
    });
    expect(home.scrollTop).toBe(416);
    expect(document.activeElement).toBe(card);
    contentTop = 600;
    act(() => resize?.());
    expect(home.scrollTop).toBe(516);
    act(() => home.dispatchEvent(new Event('wheel', { bubbles: true })));
    home.scrollTop = 40;
    contentTop = 800;
    act(() => resize?.());
    expect(home.scrollTop).toBe(40);
  });

  it('does not borrow another thread or substitute a different Home card', async () => {
    let resize: (() => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    const artifactId = artifactObjectId({
      type: 'file',
      name: 'guide.md',
      catId: null,
      sourceMessageId: null,
      createdAt: 17,
    });
    await renderHome({
      threadId: 'other-thread',
      workspaceArtifactReturnOrigin: {
        kind: 'workspace-home-artifact',
        threadId: 'source-thread',
        artifactId,
        viewportOffsetPx: 84,
      },
    });
    const home = getElement<HTMLElement>('[data-testid="f307-workspace-home-page"]');
    const wrong = document.createElement('button');
    wrong.dataset.homeArtifactId = 'different-card';
    home.append(wrong);
    home.scrollTop = 40;
    act(() => resize?.());
    expect(home.scrollTop).toBe(40);
    expect(document.activeElement).not.toBe(wrong);
  });
});
