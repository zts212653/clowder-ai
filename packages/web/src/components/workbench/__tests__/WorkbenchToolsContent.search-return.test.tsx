import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { V2WorkspaceMenu } from '@/components/workspace/V2WorkspaceMenu';
import type { LauncherWorkspaceSearch } from '@/components/workspace/WorkspaceLauncherSearch';
import type { ToolsReturnRequest } from '../use-tools-viewport-return';
import { WorkbenchToolsContent } from '../WorkbenchToolsContent';

vi.mock('@/components/workspace-home/use-changed-file-count', () => ({ useChangedFileCount: () => null }));

let container: HTMLDivElement;
let root: Root;
let contentTop: number;
const geometryCallbacks: (() => void)[] = [];
const search: LauncherWorkspaceSearch = {
  enabled: true,
  results: [{ path: 'DESIGN.md', line: 17, content: '', contextBefore: '', contextAfter: '', matchType: 'filename' }],
  loading: false,
  error: null,
  onSearch: vi.fn(async () => undefined),
  onReset: vi.fn(),
  onOpenResult: vi.fn(),
  onViewAll: vi.fn(),
};
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  vi.clearAllMocks();
  geometryCallbacks.length = 0;
  contentTop = 1500;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        geometryCallbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return this.closest('[hidden]')
      ? ([] as unknown as DOMRectList)
      : ([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(288);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2400);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const viewport = this.closest<HTMLElement>('[data-v2-workspace-menu]');
    return new DOMRect(
      20,
      this.dataset.testid === 'workspace-launcher-search' ? contentTop - (viewport?.scrollTop ?? 0) : 0,
      240,
      20,
    );
  });
  container = document.createElement('div');
  document.body.append(container);
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
const request = (generation = 1, offset: number | undefined = 84): ToolsReturnRequest => ({
  generation,
  threadId: 'thread-a',
  worktreeId: 'worktree-a',
  query: 'DESIGN.md',
  viewportOffsetPx: offset,
});
async function renderMenu(
  returnRequest?: ToolsReturnRequest,
  scope = 'thread-a:worktree-a',
  initialQuery = 'DESIGN.md',
) {
  await act(async () =>
    root.render(
      <V2WorkspaceMenu
        trigger="+"
        triggerProps={{}}
        width={288}
        openRequest={returnRequest?.generation}
        focusSelector='[data-testid="workspace-launcher-search"]'
        scopeKey={scope}
      >
        {(close, menu) => (
          <WorkbenchToolsContent
            key={`${scope}:${returnRequest?.generation ?? 0}`}
            menu={menu}
            returnRequest={returnRequest}
            threadId="thread-a"
            initialSearchQuery={initialQuery}
            workspaceSearch={search}
            onClose={close}
            onSelectDestination={() => undefined}
            onSelectDevSurface={() => undefined}
            onOpenSettings={() => undefined}
            recentSurfaces={[]}
            onSelectRecentSurface={() => undefined}
          />
        )}
      </V2WorkspaceMenu>,
    ),
  );
}
function element<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing actual tools control: ${selector}`);
  return node;
}
async function openMenu() {
  await act(async () => {
    const details = element<HTMLDetailsElement>('details');
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
}
async function settleSearch() {
  await act(async () => vi.advanceTimersByTimeAsync(250));
}
async function geometry() {
  await act(async () => {
    for (const callback of geometryCallbacks) callback();
  });
}

it('captures the actual popup viewport and full host identity before the original file callback and close', async () => {
  await renderMenu();
  await openMenu();
  await settleSearch();
  const viewport = element<HTMLElement>('[data-v2-workspace-menu]');
  viewport.scrollTop = 1522;
  let visibleAtOpen = false;
  vi.mocked(search.onOpenResult).mockImplementation(() => {
    visibleAtOpen = !viewport.hidden;
  });
  await act(async () => element<HTMLButtonElement>('[data-testid="workspace-launcher-file-result"]').click());
  expect(search.onOpenResult).toHaveBeenCalledWith('DESIGN.md', 17, {
    kind: 'workspace-tools-search',
    threadId: 'thread-a',
    query: 'DESIGN.md',
    viewportOffsetPx: -22,
  });
  expect(visibleAtOpen).toBe(true);
  expect(viewport.hidden).toBe(true);
});

it('re-reads the same query once per accepted return, without searching while closed or on geometry delivery', async () => {
  await renderMenu();
  await settleSearch();
  expect(search.onSearch).not.toHaveBeenCalled();
  await renderMenu(request(1));
  await settleSearch();
  expect(search.onSearch).toHaveBeenCalledTimes(1);
  expect(search.onSearch).toHaveBeenLastCalledWith('DESIGN.md');
  await geometry();
  await renderMenu(request(1));
  await settleSearch();
  expect(search.onSearch).toHaveBeenCalledTimes(1);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await renderMenu(request(1));
  await settleSearch();
  expect(element<HTMLElement>('[data-v2-workspace-menu]').hidden).toBe(true);
  expect(search.onSearch).toHaveBeenCalledTimes(1);
  await renderMenu(request(2));
  await settleSearch();
  expect(search.onSearch).toHaveBeenCalledTimes(2);
});

it.each([
  'wheel',
  'keydown',
  'input',
] as const)('restores late popup geometry until explicit %s releases it', async (event) => {
  await renderMenu(request());
  await settleSearch();
  const viewport = element<HTMLElement>('[data-v2-workspace-menu]');
  const input = element<HTMLInputElement>('[data-testid="workspace-launcher-search"]');
  expect(input.value).toBe('DESIGN.md');
  expect(document.activeElement).toBe(input);
  expect(input.getBoundingClientRect().top - viewport.getBoundingClientRect().top).toBe(84);
  contentTop = 1700;
  await geometry();
  expect(viewport.scrollTop).toBe(1616);
  await act(async () => input.dispatchEvent(new Event(event, { bubbles: true })));
  viewport.scrollTop = 40;
  contentTop = 2000;
  await geometry();
  expect(viewport.scrollTop).toBe(40);
});

it('releases old geometry on close and scope change, and gives Escape focus to the one trigger', async () => {
  await renderMenu(request());
  const viewport = element<HTMLElement>('[data-v2-workspace-menu]');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.activeElement).toBe(element('summary'));
  viewport.scrollTop = 40;
  contentTop = 2000;
  await geometry();
  expect(viewport.scrollTop).toBe(40);
  await renderMenu(request(2));
  await renderMenu(request(2), 'thread-b:worktree-b');
  expect(viewport.hidden).toBe(true);
  viewport.scrollTop = 50;
  await geometry();
  expect(viewport.scrollTop).toBe(50);
});

it('does not apply a different query coordinate and clamps unreachable offsets to the real scroll range', async () => {
  await renderMenu(request(), undefined, 'VISION.md');
  const viewport = element<HTMLElement>('[data-v2-workspace-menu]');
  expect(viewport.scrollTop).toBe(0);
  await renderMenu(request(2, -1000));
  expect(viewport.scrollTop).toBe(1800);
});

it('treats an old Home return as query compatibility, with no transplanted Home coordinate', async () => {
  await renderMenu({ ...request(1), viewportOffsetPx: undefined });
  const viewport = element<HTMLElement>('[data-v2-workspace-menu]');
  expect(viewport.scrollTop).toBe(0);
  expect(document.activeElement).toBe(element('[data-testid="workspace-launcher-search"]'));
  await settleSearch();
  expect(search.onSearch).toHaveBeenCalledTimes(1);
});
