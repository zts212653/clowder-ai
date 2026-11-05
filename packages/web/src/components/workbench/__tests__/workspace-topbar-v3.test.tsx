// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { ContextualWorkspaceChrome } from '@/components/workspace/ContextualWorkspaceChrome';
import { useChatStore } from '@/stores/chatStore';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { F307WorkbenchTabs, type F307WorkbenchTabsProps } from '../F307WorkbenchTabs';
import { createBrowserSurface, createFileSurface } from '../real-surface-adapters';
import { createInitialWorkbenchState } from '../workbench-model';

let host: HTMLDivElement;
let root: Root;
let props: F307WorkbenchTabsProps;
const fold = vi.fn();
const file = createFileSurface({ worktreeId: 'wt-v3', path: 'docs/guide.md' });
const pinned = createBrowserSurface({ ownerKey: 'wt-v3', port: 5312, path: '/' });
const other = createFileSurface({ worktreeId: 'wt-other', path: 'notes.md' });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  writeShellLanguage('zh');
  writeShellPresentation('v2');
  fold.mockClear();
  const layout = {
    ...createInitialWorkbenchState(),
    surfaces: [file, pinned, other],
    activeSurfaceId: file.id,
    pinnedSurfaceIds: [pinned.id],
  };
  useF307ExperienceWorkbenchStore.setState({ layout, focusSurfaceId: null });
  useChatStore.setState({ currentThreadId: 'thread-v3', presentationLock: null });
  props = {
    layout,
    dispatch: useF307ExperienceWorkbenchStore.getState().dispatch,
    onAddSurface: vi.fn(),
    onActivateSurface: vi.fn(),
    homeFocused: false,
    isDesktop: true,
    artifactWorkHostAvailable: false,
    mainAreaAttentionSurfaceId: null,
    onEnterMainAreaAttention: vi.fn(),
    onExitMainAreaAttention: vi.fn(),
  };
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
    new DOMRect(0, 0, 240, 32),
  ] as unknown as DOMRectList);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  writeShellPresentation('classic');
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState(), focusSurfaceId: null });
  useChatStore.setState({ presentationLock: null });
});

function render() {
  act(() =>
    root.render(
      <ContextualWorkspaceChrome mode="workspace" onFold={fold} showFold>
        <F307WorkbenchTabs {...props} />
      </ContextualWorkspaceChrome>,
    ),
  );
}
function openActions() {
  const trigger = host.querySelector<HTMLElement>('[aria-label="更多 Workspace 操作"]');
  const details = trigger?.closest('details');
  if (!details) throw new Error('missing original Workspace actions disclosure');
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  return document.getElementById(trigger?.getAttribute('aria-controls') ?? '');
}
function menuAction(name: string) {
  const menu = openActions();
  const button = Array.from(menu?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (node) => node.getAttribute('aria-label') === name || node.textContent?.trim() === name,
  );
  if (!button) throw new Error(`missing named menu action ${name}`);
  return button;
}

it('keeps only tools and actions at the right, each with the accepted accessible name and no native title', () => {
  render();
  const actions = host.querySelector('[data-testid="v2-workspace-actions"]');
  expect(actions).not.toBeNull();
  expect(
    Array.from(actions?.querySelectorAll('summary, button') ?? []).map((node) => node.getAttribute('aria-label')),
  ).toEqual(['打开工具或文件', '更多 Workspace 操作']);
  expect(actions?.querySelector('[title]')).toBeNull();
});

it('makes Home a named tab without a close button, rather than using the plus button as Home', () => {
  props.homeFocused = true;
  render();
  const home = host.querySelector('[data-testid="v2-workspace-home"]');
  expect(home?.getAttribute('role')).toBe('tab');
  expect(home?.getAttribute('aria-selected')).toBe('true');
  expect(home?.textContent).toContain('首页');
  expect(home?.parentElement?.querySelector('[data-testid="v2-close-tab"]')).toBeNull();
  act(() => (home as HTMLButtonElement)?.click());
  expect(props.onAddSurface).toHaveBeenCalledOnce();
});

it('exposes the seven named actions in design order without nesting the old plus or management controls', () => {
  render();
  const menu = openActions();
  expect(
    Array.from(menu?.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]') ?? []).map(
      (node) => node.getAttribute('aria-label') ?? node.textContent?.trim(),
    ),
  ).toEqual(['专注当前工具', '整窗', '左右并排', '锁定视图', '关闭其他标签', '关闭全部标签', '收起 Workspace']);
  expect(menu?.textContent).toContain('聊天还在');
  expect(menu?.textContent).toContain('换对话时不变');
  expect(menu?.querySelector('[data-testid="f307-control-rail"]')).toBeNull();
});

it('shows only usable actions on Home, retaining close-all, unlock and collapse when available', () => {
  props.homeFocused = true;
  render();
  let menu = openActions();
  const labels = () =>
    Array.from(menu?.querySelectorAll<HTMLButtonElement>('button') ?? []).map((node) =>
      node.getAttribute('aria-label'),
    );
  expect(labels()).toEqual(['关闭全部标签', '收起 Workspace']);
  expect(menu?.querySelector('button:disabled')).toBeNull();

  act(() =>
    useChatStore.setState({
      presentationLock: {
        ownerThreadId: 'thread-v3',
        ownerWorkspace: { worktreeId: 'wt-v3', filePath: 'docs/guide.md', line: null, tabs: ['docs/guide.md'] },
        surfaceId: file.id,
        worktreeId: 'wt-v3',
        filePath: 'docs/guide.md',
        line: null,
        tabs: ['docs/guide.md'],
        scrollTop: null,
      },
    }),
  );
  menu = openActions();
  expect(labels()).toEqual(['锁定视图', '关闭全部标签', '收起 Workspace']);
  act(() => menuAction('锁定视图').click());
  expect(useChatStore.getState().presentationLock).toBeNull();

  props.layout = { ...props.layout, surfaces: [pinned], pinnedSurfaceIds: [pinned.id] };
  render();
  menu = openActions();
  expect(labels()).toEqual(['收起 Workspace']);
});

it('focuses and splits with the original F307 actions', () => {
  render();
  act(() => menuAction('专注当前工具').click());
  expect(useF307ExperienceWorkbenchStore.getState().focusSurfaceId).toBe(file.id);
  act(() => useF307ExperienceWorkbenchStore.getState().exitFocusMode());
  act(() => menuAction('左右并排').click());
  expect(useF307ExperienceWorkbenchStore.getState().layout.split).toMatchObject({
    primarySurfaceId: file.id,
    secondarySurfaceId: pinned.id,
  });
});

it('keeps the original canonical file lock behind the named menu item', () => {
  render();
  act(() => menuAction('锁定视图').click());
  expect(useChatStore.getState().presentationLock).toMatchObject({
    surfaceId: file.id,
    worktreeId: 'wt-v3',
    filePath: 'docs/guide.md',
  });
});

it('closes other tabs from the one actions menu while retaining current and pinned descriptors', () => {
  render();
  act(() => menuAction('关闭其他标签').click());
  const state = useF307ExperienceWorkbenchStore.getState().layout;
  expect(state.surfaces).toEqual([file, pinned]);
  expect(state.pinnedSurfaceIds).toEqual([pinned.id]);
  expect(state.recentlyClosed).toContainEqual(other);
});

it('closes all unpinned tabs and folds through the original host without stopping any owner', () => {
  render();
  act(() => menuAction('关闭全部标签').click());
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces).toEqual([pinned]);
  act(() => menuAction('收起 Workspace').click());
  expect(fold).toHaveBeenCalledOnce();
});

it('names the Chinese overflow count and keeps the same trigger when switching to English', () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(240);
  render();
  const trigger = host.querySelector('[data-testid="v2-more-tabs"]');
  expect(trigger?.textContent).toMatch(/还有 \d+ 个/);
  act(() => writeShellLanguage('en'));
  expect(host.querySelector('[data-testid="v2-more-tabs"]')).toBe(trigger);
  expect(trigger?.textContent).toMatch(/More \d+/);
});

it('keeps all short tabs visible when their measured complete widths fit the header', () => {
  props.layout = {
    ...props.layout,
    surfaces: [file, pinned, other].map((surface, index) => ({ ...surface, title: ['文件', '作品', '变更'][index] })),
  };
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const id = this.getAttribute('data-tab-surface-id');
    const width = id === file.id ? 96 : id ? 70 : this.matches('[data-testid="v2-more-tabs"]') ? 80 : 56;
    return new DOMRect(0, 0, width, 32);
  });
  render();
  expect(host.querySelectorAll('[role="tablist"] [data-tab-surface-id]')).toHaveLength(3);
  expect(host.querySelector('[data-testid="v2-more-tabs"]')).toBeNull();
});

it.each([
  { selected: 'home', expected: 3 },
  { selected: 'first', expected: 2 },
  { selected: 'middle', expected: 2 },
])('puts separators only between inactive neighbors with $selected selected', ({ selected, expected }) => {
  const fourth = createFileSurface({ worktreeId: 'wt-fourth', path: 'fourth.md' });
  props.layout = {
    ...props.layout,
    surfaces: [file, pinned, other, fourth],
    activeSurfaceId: selected === 'middle' ? pinned.id : file.id,
  };
  props.homeFocused = selected === 'home';
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  render();
  const tabs = host.querySelector('[role="tablist"]');
  const separators = Array.from(tabs?.querySelectorAll<HTMLElement>('[data-v2-tab-separator]') ?? []);
  expect(separators).toHaveLength(expected);
  for (const line of separators) {
    expect(line.getAttribute('aria-hidden')).toBe('true');
    expect(line.previousElementSibling?.querySelector('[aria-selected="true"]')).toBeNull();
    expect(line.nextElementSibling?.querySelector('[aria-selected="true"]')).toBeNull();
  }
});

it('uses the host full-window callback and preserves keyboard movement and Escape focus', () => {
  const onToggle = vi.fn();
  props.fullWindowAction = { active: false, onToggle };
  props.artifactWorkHostAvailable = true;
  render();
  act(() => menuAction('整窗').click());
  expect(onToggle).toHaveBeenCalledOnce();
  const menu = openActions();
  const first = menu?.querySelector<HTMLButtonElement>('button');
  act(() => first?.focus());
  act(() => first?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  expect(document.activeElement?.getAttribute('aria-label')).toBe('整窗');
  act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(document.activeElement?.getAttribute('aria-label')).toBe('收起 Workspace');
  act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  const trigger = host.querySelector<HTMLElement>('[aria-label="更多 Workspace 操作"]');
  expect(trigger?.closest('details')?.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
});

it('keeps a named return-to-chat action visible while an ordinary surface is full-window', () => {
  props.mainAreaAttentionSurfaceId = file.id;
  props.mainAreaAttentionIsWide = false;
  render();

  const back = host.querySelector<HTMLButtonElement>('[data-testid="v2-workspace-return-to-chat"]');
  expect(back?.textContent).toContain('回到聊天');
  act(() => back?.click());
  expect(props.onExitMainAreaAttention).toHaveBeenCalledOnce();
});
