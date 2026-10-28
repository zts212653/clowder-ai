// @vitest-environment jsdom
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import type { WorkspaceFileViewerProps } from '../WorkspaceFileViewer.types';

const desktopAction = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ local: true, path: '/registered/source/docs/guide.md', canOpen: true, canReveal: true }),
  }),
);
vi.mock('@/utils/api-client', () => ({ API_URL: '', apiFetch: desktopAction }));

vi.mock('../FileContentRenderer', () => ({
  FileContentRenderer: () => <textarea data-testid="owner-content" defaultValue="draft retained" />,
}));
vi.mock('../useWorkspaceListenMode', () => ({
  useWorkspaceListenMode: () => ({
    active: false,
    cache: { active: false, cachedAnchors: [], totalSentences: 2 },
    sentences: [1, 2],
    activeAnchor: null,
    start: vi.fn(),
    cancelCache: vi.fn(),
    startCache: vi.fn(),
  }),
}));

import { WorkspaceFileViewer } from '../WorkspaceFileViewer';

let host: HTMLDivElement, root: Root;
const props = (): WorkspaceFileViewerProps => ({
  file: {
    path: 'docs/guide.md',
    content: '# guide',
    size: 7,
    sha256: 'digest',
    mime: 'text/markdown',
    truncated: false,
  },
  openFilePath: 'docs/guide.md',
  openTabs: ['docs/guide.md'],
  canEdit: true,
  editMode: false,
  isMarkdown: true,
  isHtml: false,
  isJsx: false,
  markdownRendered: true,
  htmlPreview: false,
  jsxPreview: false,
  saveError: null,
  scrollToLine: null,
  worktreeId: 'fixture',
  setOpenFile: vi.fn(),
  closeTab: vi.fn(),
  onCloseCurrentTab: vi.fn(),
  onToggleEdit: vi.fn(),
  onToggleMarkdownRendered: vi.fn(),
  onToggleHtmlPreview: vi.fn(),
  onToggleJsxPreview: vi.fn(),
  onSave: vi.fn(),
  collaborationAvailable: true,
  onOpenCollaboration: vi.fn(),
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  desktopAction.mockClear();
  writeShellPresentation('v2');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
it.each([true, false])('keeps the HTML action unfilled with page preview=%s', (htmlPreview) => {
  writeShellLanguage('zh');
  const original = props();
  const p = {
    ...original,
    file: { ...original.file, path: 'index.html', mime: 'text/html' },
    openFilePath: 'index.html',
    openTabs: ['index.html'],
    isMarkdown: false,
    isHtml: true,
    htmlPreview,
  };
  act(() => root.render(<WorkspaceFileViewer {...p} />));
  const toolbar = host.querySelector('[data-testid="workspace-file-toolbar"]');
  assert(toolbar);
  const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>('button')];
  const toggle = buttons.find((button) => button.textContent === (htmlPreview ? '看源码' : '页面预览'));
  const ask = buttons.find((button) => button.textContent === '请猫修改');
  assert(toggle && ask);
  expect(toggle.className).toBe(ask.className);
  expect(toggle.className).not.toContain('bg-cafe-accent');
  act(() => toggle.click());
  expect(p.onToggleHtmlPreview).toHaveBeenCalledOnce();
});
it.each(['markdown', 'jsx'] as const)('preserves the filled %s state label', (kind) => {
  writeShellLanguage('zh');
  const base = props();
  const p = {
    ...base,
    file: kind === 'jsx' ? { ...base.file, path: 'Example.tsx', mime: 'text/tsx' } : base.file,
    openFilePath: kind === 'jsx' ? 'Example.tsx' : base.openFilePath,
    isMarkdown: kind === 'markdown',
    isJsx: kind === 'jsx',
    jsxPreview: true,
  };
  act(() => root.render(<WorkspaceFileViewer {...p} />));
  const toolbar = host.querySelector('[data-testid="workspace-file-toolbar"]');
  assert(toolbar);
  const toggle = [...toolbar.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === (kind === 'markdown' ? '渲染' : '预览'),
  );
  assert(toggle);
  expect(toggle.className).toContain('bg-cafe-accent');
});
it.each([
  'zh',
  'en',
] as const)('keeps localized native file operations in the original %s Workspace menu', async (language) => {
  writeShellLanguage(language);
  const original = props();
  const p = { ...original, file: { ...original.file, absolutePath: '/registered/source/docs/guide.md' } };
  const copyPath = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copyPath } });
  act(() => root.render(<WorkspaceFileViewer {...p} />));
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  await act(async () => trigger.click());
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  const labels = [...menu.querySelectorAll('button')].map((button) => button.textContent);
  expect(labels).toContain(language === 'en' ? 'Copy path' : '复制路径');
  expect(labels).toContain(language === 'en' ? 'Show in Finder' : '在 Finder 中显示');
  const openLabel = language === 'en' ? 'Open with default application' : '用默认应用打开';
  expect(labels).toContain(openLabel);
  if (language === 'en') expect(menu.textContent).not.toMatch(/[\u3400-\u9fff]/);
  expect(desktopAction.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  const copy = [...menu.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === (language === 'en' ? 'Copy path' : '复制路径'),
  )!;
  await act(async () => copy.click());
  expect(copyPath).toHaveBeenCalledWith('/registered/source/docs/guide.md');
  await act(async () => trigger.click());
  const reopened = document.querySelector<HTMLElement>('[role="menu"]')!;
  const open = [...reopened.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === openLabel,
  )!;
  await act(async () => open.click());
  expect(desktopAction).toHaveBeenCalledWith(
    '/api/workspace/file/actions/open?worktreeId=fixture&path=docs%2Fguide.md',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});
it('v2 keeps the named return, primary edit controls and the same file menu', async () => {
  const p = {
    ...props(),
    navigationOrigin: { kind: 'file-tree' as const },
    onBack: vi.fn(),
    onRevealInTree: vi.fn(),
    annotationCount: 3,
  };
  act(() => root.render(<WorkspaceFileViewer {...p} />));
  const tabs = host.querySelector('[data-testid="v2-file-tabs"]');
  expect(tabs?.textContent).toContain('‹ 文件');
  expect(tabs?.textContent).toContain('guide.md');
  const toolbar = host.querySelector('[data-testid="workspace-file-toolbar"]');
  expect(toolbar?.textContent).toContain('请猫修改');
  expect(toolbar?.textContent).toContain('批注 3');
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger?.click());
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  const edit = [...toolbar!.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === '编辑',
  );
  expect(edit).toBeDefined();
  act(() => edit!.click());
  expect(p.onToggleEdit).toHaveBeenCalledOnce();
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="v2-file-back"]')?.click());
  expect(p.onBack).toHaveBeenCalledOnce();
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="v2-file-directory"]')?.click());
  expect(p.onRevealInTree).toHaveBeenCalledOnce();
});
it('focus hides both file chrome layers and preserves the mounted content and draft', () => {
  const p = props();
  act(() => root.render(<WorkspaceFileViewer {...p} />));
  const content = host.querySelector<HTMLTextAreaElement>('[data-testid="owner-content"]')!;
  content.value = 'unsaved edit';
  act(() => root.render(<WorkspaceFileViewer {...p} focusMode />));
  expect(host.querySelector('[data-testid="v2-file-chrome"]')?.hasAttribute('hidden')).toBe(true);
  expect(host.querySelector('[data-testid="owner-content"]')).toBe(content);
  expect(content.value).toBe('unsaved edit');
  act(() => root.render(<WorkspaceFileViewer {...p} />));
  expect(content.value).toBe('unsaved edit');
});
it('names the meeting return in the actual v2 file chrome and keeps that return action through focus', () => {
  const p = {
    ...props(),
    navigationOrigin: { kind: 'meeting-transcript' as const, threadId: 'thread-origin' },
    onBack: vi.fn(),
  };
  act(() => root.render(<WorkspaceFileViewer {...p} />));
  const content = host.querySelector<HTMLTextAreaElement>('[data-testid="owner-content"]')!;
  const back = host.querySelector<HTMLButtonElement>('[data-testid="v2-file-back"]')!;
  expect(back.textContent).toBe('‹ 会议伴随');
  content.value = 'meeting source draft retained';
  act(() => root.render(<WorkspaceFileViewer {...p} focusMode />));
  act(() => root.render(<WorkspaceFileViewer {...p} />));
  expect(host.querySelector('[data-testid="owner-content"]')).toBe(content);
  expect(content.value).toBe('meeting source draft retained');
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="v2-file-back"]')!.click());
  expect(p.onBack).toHaveBeenCalledOnce();
});
it('classic keeps its original toolbar and collaboration control', () => {
  writeShellPresentation('classic');
  act(() => root.render(<WorkspaceFileViewer {...props()} />));
  expect(host.querySelector('[data-testid="v2-file-chrome"]')).toBeNull();
  expect(host.textContent).toContain('Rendered');
  expect(host.textContent).toContain('协作批注');
});

it.each<{ label: string; origin: WorkspaceFileViewerProps['navigationOrigin'] }>([
  {
    label: '‹ Workspace 首页',
    origin: { kind: 'workspace-home-artifact', threadId: 'origin', artifactId: 'card-key', viewportOffsetPx: -10 },
  },
  {
    label: '‹ 工具搜索',
    origin: { kind: 'workspace-tools-search', threadId: 'origin', query: 'guide.md', viewportOffsetPx: 10 },
  },
  { label: '‹ 工具搜索', origin: { kind: 'workspace-home-search', query: 'guide.md' } },
  { label: '‹ 文件', origin: undefined },
])('keeps $label on the same-page reader with quote controls', ({ label, origin }) => {
  const p = { ...props(), navigationOrigin: origin, onBack: vi.fn(), showFileQuotes: true };
  act(() => root.render(<WorkspaceFileViewer {...p} />));
  const content = host.querySelector('[data-testid="owner-content"]');
  const back = host.querySelector<HTMLButtonElement>('[data-testid="v2-file-back"]');
  if (!back) throw new Error('The same-page file reader must expose its original Back action');
  expect(back.textContent).toBe(label);
  act(() => back.click());
  expect(p.onBack).toHaveBeenCalledOnce();
  expect(host.querySelector('[data-testid="owner-content"]')).toBe(content);
});
