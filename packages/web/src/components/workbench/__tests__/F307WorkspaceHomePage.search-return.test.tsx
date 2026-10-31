import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { F307WorkspaceHomePage } from '../F307WorkspaceHomePage';

const mocks = vi.hoisted(() => ({
  setWorkspaceMode: vi.fn(),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: { setWorkspaceMode: typeof mocks.setWorkspaceMode; threads: [] }) => unknown) =>
    selector({ setWorkspaceMode: mocks.setWorkspaceMode, threads: [] }),
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
vi.mock('@/components/workspace-home/HomeLiveCard', () => ({ HomeLiveCard: () => null }));
vi.mock('@/components/workspace-home/HomeWaitCard', () => ({ HomeWaitCard: () => null }));

describe('F307 Home return search restoration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
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

  function getElement<T extends HTMLElement>(selector: string): T {
    const element = container.querySelector<T>(selector);
    if (!element) throw new Error(`Missing Home control: ${selector}`);
    return element;
  }

  const results = [
    { path: 'DESIGN.md', line: 0, content: '', contextBefore: '', contextAfter: '', matchType: 'filename' as const },
  ];
  const search = (onOpenResult = vi.fn()) => ({
    enabled: true,
    results,
    loading: false,
    error: null,
    onSearch: vi.fn(async () => undefined),
    onReset: vi.fn(),
    onOpenResult,
    onViewAll: vi.fn(),
    fileNavigationOrigin: () => ({ kind: 'workspace-home-search' as const, query: 'DESIGN.md' }),
  });

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
          workspaceSearchQuery="DESIGN.md"
          workspaceSearch={search()}
          {...overrides}
        />,
      ),
    );
  }

  it('classic captures the search position before opening a file', async () => {
    writeShellPresentation('classic');
    const onOpenResult = vi.fn();
    await renderHome({ workspaceSearch: search(onOpenResult) });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    const home = getElement<HTMLElement>('[data-testid="f307-workspace-home-page"]');
    const input = getElement<HTMLInputElement>('[data-testid="workspace-launcher-search"]');
    vi.spyOn(home, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ top: 184 } as DOMRect);
    await act(async () => getElement<HTMLButtonElement>('[data-testid="workspace-launcher-file-result"]').click());
    expect(onOpenResult).toHaveBeenCalledWith('DESIGN.md', 0, {
      kind: 'workspace-home-search',
      query: 'DESIGN.md',
      viewportOffsetPx: 84,
    });
  });

  it('classic restores the same query and source viewport after Home remounts', async () => {
    writeShellPresentation('classic');
    // jsdom has no layout: model the actual Home scroll owner, with the search below many live rows.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const home = this.closest<HTMLElement>('[data-testid="f307-workspace-home-page"]');
      return {
        top: this.dataset.testid === 'workspace-launcher-search' ? 1510 - (home?.scrollTop ?? 0) : 10,
        height: 20,
      } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    await renderHome({
      workspaceSearchReturnOrigin: { kind: 'workspace-home-search', query: 'DESIGN.md', viewportOffsetPx: 84 },
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    const home = getElement<HTMLElement>('[data-testid="f307-workspace-home-page"]');
    const input = getElement<HTMLInputElement>('[data-testid="workspace-launcher-search"]');
    expect(home.scrollTop).toBe(1416);
    expect(input.value).toBe('DESIGN.md');
    expect(input.getBoundingClientRect().top - home.getBoundingClientRect().top).toBe(84);
    expect(container.textContent).toContain('DESIGN.md');
  });

  it.each([
    'wheel',
    'keydown',
  ] as const)('restores late result layout but releases the viewport on user %s', async (event) => {
    writeShellPresentation('classic');
    let resize: (() => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {
          disconnect();
        }
      },
    );
    let contentTop = 1500;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const home = this.closest<HTMLElement>('[data-testid="f307-workspace-home-page"]');
      return {
        top: this.dataset.testid === 'workspace-launcher-search' ? contentTop - (home?.scrollTop ?? 0) : 0,
        height: 20,
      } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    await renderHome({
      workspaceSearchReturnOrigin: { kind: 'workspace-home-search', query: 'DESIGN.md', viewportOffsetPx: 84 },
    });
    const home = getElement<HTMLElement>('[data-testid="f307-workspace-home-page"]');
    contentTop = 1900;
    await act(async () => resize?.());
    expect(home.scrollTop).toBe(1816);
    expect(document.activeElement).toBe(container.querySelector('[data-testid="workspace-launcher-search"]'));
    home.dispatchEvent(new Event(event, { bubbles: true }));
    expect(disconnect).toHaveBeenCalled();
    home.scrollTop = 40;
    contentTop = 2200;
    await act(async () => resize?.());
    expect(home.scrollTop).toBe(40);
  });

  it('does not borrow another query viewport on a delayed layout update', async () => {
    writeShellPresentation('classic');
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    await renderHome({
      workspaceSearchQuery: 'VISION.md',
      workspaceSearchReturnOrigin: { kind: 'workspace-home-search', query: 'DESIGN.md', viewportOffsetPx: 84 },
    });
    const home = getElement<HTMLElement>('[data-testid="f307-workspace-home-page"]');
    expect(home.scrollTop).toBe(0);
    expect(getElement<HTMLInputElement>('[data-testid="workspace-launcher-search"]').value).toBe('VISION.md');
    expect(document.activeElement).not.toBe(container.querySelector('[data-testid="workspace-launcher-search"]'));
  });

  it('classic covers content added after search settles until explicit input', async () => {
    writeShellPresentation('classic');
    const observers: { callback: () => void; targets: Map<Element, number> }[] = [];
    // Only an observed node whose border-box height changes emits a resize. Inserting a sibling does not
    // resize the fixed scroller or its old children; this is the platform distinction missed by the old test.
    const height = (node: Element): number => {
      if (node.matches('[data-testid="f307-workspace-home-page"]')) return 600;
      const added = node.querySelector<HTMLElement>('[data-late-home-return]');
      return 100 + Number(added?.dataset.height ?? 0);
    };
    vi.stubGlobal(
      'ResizeObserver',
      class {
        state: { callback: () => void; targets: Map<Element, number> };
        constructor(callback: () => void) {
          this.state = { callback, targets: new Map() };
          observers.push(this.state);
        }
        observe(node: Element) {
          this.state.targets.set(node, height(node));
        }
        disconnect() {
          this.state.targets.clear();
        }
      },
    );
    const flushGeometry = () => {
      for (const observer of observers) {
        let changed = false;
        for (const [node, before] of observer.targets) {
          const after = height(node);
          if (after !== before) changed = true;
          observer.targets.set(node, after);
        }
        if (changed) observer.callback();
      }
    };
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const home = this.closest<HTMLElement>('[data-testid="f307-workspace-home-page"]');
      const added = home?.querySelector<HTMLElement>('[data-late-home-return]');
      return {
        top:
          this.dataset.testid === 'workspace-launcher-search'
            ? 1500 + Number(added?.dataset.height ?? 0) - (home?.scrollTop ?? 0)
            : 0,
        height: 20,
      } as DOMRect;
    });
    await renderHome({
      workspaceSearchReturnOrigin: { kind: 'workspace-home-search', query: 'DESIGN.md', viewportOffsetPx: 84 },
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    const home = getElement<HTMLElement>('[data-testid="f307-workspace-home-page"]');
    const input = getElement<HTMLInputElement>('[data-testid="workspace-launcher-search"]');
    expect(input.getBoundingClientRect().top).toBe(84);
    // The stable classic content box includes sections inserted after the search settled.
    const content = getElement<HTMLElement>('[data-workspace-home-content]');
    const added = document.createElement('section');
    added.dataset.lateHomeReturn = '';
    added.dataset.height = '80';
    await act(async () => {
      content.prepend(added);
      flushGeometry();
    });
    expect(input.getBoundingClientRect().top).toBe(84);
    await act(async () => {
      added.dataset.height = '160';
      flushGeometry();
    });
    expect(input.getBoundingClientRect().top).toBe(84);
    home.dispatchEvent(new Event('wheel', { bubbles: true }));
    home.scrollTop = 40;
    await act(async () => {
      added.dataset.height = '240';
      flushGeometry();
    });
    expect(home.scrollTop).toBe(40);
  });
});
