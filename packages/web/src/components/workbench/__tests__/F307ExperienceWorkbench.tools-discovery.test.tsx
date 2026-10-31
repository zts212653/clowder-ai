import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { F307ExperienceWorkbench } from '../F307ExperienceWorkbench';
import { createInitialWorkbenchState } from '../workbench-model';

vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => false }));
vi.mock('@/components/listen-mode/ListenModePlayer', () => ({ ListenModePlayer: () => null }));
vi.mock('@/components/workspace-home/WorkspaceHomeV2', () => ({ WorkspaceHomeV2: () => null }));
vi.mock('@/components/workspace-home/use-changed-file-count', () => ({ useChangedFileCount: () => null }));

let container: HTMLDivElement;
let root: Root;
let previousChat: ReturnType<typeof useChatStore.getState>;
let previousWorkbench: ReturnType<typeof useF307ExperienceWorkbenchStore.getState>;
const search = {
  results: [],
  loading: false,
  error: null,
  onSearch: vi.fn(),
  onReset: vi.fn(),
  onOpenResult: vi.fn(),
  onViewAll: vi.fn(),
};
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  writeShellPresentation('v2');
  previousChat = useChatStore.getState();
  previousWorkbench = useF307ExperienceWorkbenchStore.getState();
  useChatStore.setState({ currentThreadId: 'thread-a', presentationLock: null });
  useF307ExperienceWorkbenchStore.setState({
    layout: createInitialWorkbenchState(),
    hydrated: true,
    focusSurfaceId: null,
    mainAreaAttentionSurfaceId: null,
  });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return this.closest('[hidden]')
      ? ([] as unknown as DOMRectList)
      : ([new DOMRect(0, 0, 32, 32)] as unknown as DOMRectList);
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useChatStore.setState(previousChat, true);
  useF307ExperienceWorkbenchStore.setState(previousWorkbench, true);
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});
async function renderHost(worktreeId: string | null, threadId = 'thread-a') {
  await act(async () => {
    useChatStore.setState({ currentThreadId: threadId });
    root.render(
      <F307ExperienceWorkbench
        threadId={threadId}
        onSelectDevSurface={() => undefined}
        onOpenAppRoute={() => undefined}
        worktreeId={worktreeId}
        worktreeLoading={worktreeId === null}
        openFilePath={null}
        preview={{ path: '/' }}
        workspaceSearch={{ ...search, enabled: worktreeId !== null }}
      />,
    );
  });
}
function element<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing actual Workspace control: ${selector}`);
  return node;
}
async function openAndType() {
  const trigger = element<HTMLElement>('[data-testid="v2-workspace-tools"]');
  const disclosure = trigger.closest('details');
  if (!disclosure) throw new Error('Missing native tools disclosure');
  await act(async () => {
    disclosure.open = true;
    disclosure.dispatchEvent(new Event('toggle'));
  });
  const input = element<HTMLInputElement>('[data-testid="workspace-launcher-search"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'DESIGN.md');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return { disclosure, input, viewport: input.closest<HTMLElement>('[data-v2-workspace-menu]') };
}

it('keeps the ordinary + menu, query, caret and focus when the first worktree is discovered', async () => {
  await renderHost(null);
  const { disclosure, input, viewport } = await openAndType();
  input.setSelectionRange(2, 6);
  if (viewport) viewport.scrollTop = 47;
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(search.onSearch).not.toHaveBeenCalled();
  await renderHost('worktree-a');
  expect(disclosure.open).toBe(true);
  expect(element('[data-testid="workspace-launcher-search"]')).toBe(input);
  expect(input.value).toBe('DESIGN.md');
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
  expect(viewport?.scrollTop).toBe(47);
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(search.onSearch).toHaveBeenCalledOnce();
  expect(search.onSearch).toHaveBeenLastCalledWith('DESIGN.md');
});

it.each([
  ['another worktree', 'worktree-b', 'thread-a'],
  ['another thread', 'worktree-a', 'thread-b'],
  ['loss of the selected worktree', null, 'thread-a'],
] as const)('dismisses and clears the previous query on %s', async (_label, worktreeId, threadId) => {
  await renderHost(null);
  await renderHost('worktree-a');
  const { disclosure, input } = await openAndType();
  expect(input.value).toBe('DESIGN.md');
  await renderHost(worktreeId, threadId);
  expect(disclosure.open).toBe(false);
  expect(element<HTMLInputElement>('[data-testid="workspace-launcher-search"]').value).toBe('');
});
