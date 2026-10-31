import type { PullRequestChangesTarget } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { WorkspaceSurfaceVisibilityProvider } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { ChangesPanel } from '../ChangesPanel';

Object.assign(globalThis as Record<string, unknown>, { React });

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

vi.mock('@/components/ThreadSidebar/ThreadNativeReviewSettings', () => ({
  ThreadNativeReviewSettingsContent: () => <div data-testid="native-review-content" />,
}));

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' line1',
  '-old',
  '+new',
  '+newer',
  'diff --git a/src/b.ts b/src/b.ts',
  'index 333..444 100644',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1,1 +1,0 @@',
  '-gone',
  '',
].join('\n');

const PAYLOAD = {
  changedFiles: [
    { status: 'M', path: 'src/a.ts' },
    { status: 'D', path: 'src/b.ts' },
  ],
  diff: DIFF,
};

describe('ChangesPanel v2', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    writeShellPresentation('v2');
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/workspace/diff')) return Response.json(PAYLOAD);
      return new Response('not found', { status: 404 });
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    writeShellPresentation('classic');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(threadId: string | null = 'thread-1', onOpenFile?: (path: string) => void, visible = true) {
    await act(async () => {
      root.render(
        <WorkspaceSurfaceVisibilityProvider visible={visible}>
          <ChangesPanel worktreeId="wt-1" basisPct={40} threadId={threadId} onOpenFile={onOpenFile} />
        </WorkspaceSurfaceVisibilityProvider>,
      );
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
  }

  it('renders the Chinese review summary and changed-file count', async () => {
    await render();
    expect(container.textContent).toContain('请 Codex 审查改动');
    expect(container.textContent).toContain('2 个文件有改动');
    expect(container.querySelector('button[title="刷新"]')).toBeTruthy();
  });

  it.each([
    'v2',
    'classic',
  ] as const)('shows the precise PR, partial truth and original Back without offering local review in %s', async (presentation) => {
    writeShellPresentation(presentation);
    const target: PullRequestChangesTarget = {
      kind: 'github-pr',
      v: 1,
      repoFullName: 'owner/repo',
      prNumber: 7,
      worktreeId: 'wt-1',
      threadId: 'thread-1',
    };
    apiFetchMock.mockResolvedValue(
      Response.json({
        ...PAYLOAD,
        target,
        comparison: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40) },
        totalChangedFiles: 301,
        completeness: 'partial',
        omissions: ['file_limit', 'missing_patch'],
      }),
    );
    const back = vi.fn();
    await act(async () => {
      root.render(
        <ChangesPanel worktreeId="wt-1" basisPct={40} threadId="thread-1" pullRequestTarget={target} onBack={back} />,
      );
    });
    expect(container.textContent).toContain('owner/repo#7');
    expect(container.textContent).toContain('仅显示部分变更');
    expect(container.querySelector('[data-testid="native-review-workspace-strip"]')).toBeNull();
    const button = container.querySelector<HTMLButtonElement>('[data-testid="changes-origin-back"]');
    expect(button).not.toBeNull();
    act(() => button?.click());
    expect(back).toHaveBeenCalledOnce();
  });

  it('restores the same diff viewport after hidden layout clamps it, while accepting a visible scroll to zero', async () => {
    await render();
    const viewport = container.querySelector<HTMLDivElement>('div[class*="overflow-auto"][class*="ws-editor-deep"]');
    if (!viewport) throw new Error('The original diff viewport is unavailable');
    viewport.scrollTop = 137;
    act(() => viewport.dispatchEvent(new Event('scroll')));
    await render('thread-1', undefined, false);
    viewport.scrollTop = 0;
    act(() => viewport.dispatchEvent(new Event('scroll')));
    await render();
    expect(container.querySelector('div[class*="overflow-auto"][class*="ws-editor-deep"]')).toBe(viewport);
    expect(viewport.scrollTop).toBe(137);
    viewport.scrollTop = 0;
    act(() => viewport.dispatchEvent(new Event('scroll')));
    await render('thread-1', undefined, false);
    await render();
    expect(viewport.scrollTop).toBe(0);
    expect(apiFetchMock.mock.calls.filter(([url]) => url.includes('/api/workspace/diff'))).toHaveLength(1);
  });

  it('shows per-file add/delete line counts parsed from the diff', async () => {
    await render();
    expect(container.textContent).toContain('+2');
    expect(container.textContent).toContain('−1');
  });

  it('passes Chinese mode labels to the diff viewer', async () => {
    await render();
    expect(container.textContent).toContain('合并');
    expect(container.textContent).toContain('并排');
  });

  it('shows the Chinese empty state', async () => {
    apiFetchMock.mockImplementation(async () => Response.json({ changedFiles: [], diff: '' }));
    await render();
    expect(container.textContent).toContain('没有未提交的改动');
  });

  it('shows the Chinese fetch error', async () => {
    apiFetchMock.mockImplementation(async () => new Response('nope', { status: 500 }));
    await render();
    expect(container.textContent).toContain('读取改动失败');
  });

  it('keeps the classic presentation untouched', async () => {
    writeShellPresentation('classic');
    await render();
    expect(container.textContent).toContain('让 Codex 检查当前改动');
    expect(container.textContent).toContain('2 changed');
  });

  // C Release da3417b125（coord-e6d806a7）：每个文件的 diff 块接「打开文件」，
  // 调用接缝 onOpenFile(path)；无 callback 时不显示假可用动作；classic 永不显示。
  it('renders an 打开文件 action per file diff block and calls onOpenFile with its path', async () => {
    const onOpenFile = vi.fn();
    await render('thread-1', onOpenFile);
    const buttons = Array.from(container.querySelectorAll('button')).filter(
      (b) => b.textContent?.trim() === '打开文件',
    );
    expect(buttons.length).toBe(2);
    await act(async () => {
      buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts');
    expect(onOpenFile).toHaveBeenCalledWith('src/b.ts');
  });

  it('shows no open-file action when onOpenFile is absent', async () => {
    await render();
    expect(container.textContent).not.toContain('打开文件');
    expect(container.textContent).not.toContain('Open file');
  });

  // #5121 delta review：无 callback 时文件头必须保持原 DOM（truncate div + 裸文本），
  // 不能因接缝存在而改成 flex+span——classic 与 v2 无 callback 走同一 header。
  it('keeps the original file header markup when onOpenFile is absent', async () => {
    await render();
    const header = Array.from(container.querySelectorAll('div')).find(
      (d) => d.className.includes('console-divider-b') && d.textContent === 'src/a.ts',
    );
    expect(header).toBeTruthy();
    expect(header?.className).toBe(
      'bg-[var(--ws-editor-bg)] px-3 py-1.5 text-xs font-mono text-cafe-muted console-divider-b truncate',
    );
    expect(header?.children.length).toBe(0);
  });

  it('keeps the original file header markup in classic', async () => {
    writeShellPresentation('classic');
    await render('thread-1', vi.fn());
    const header = Array.from(container.querySelectorAll('div')).find(
      (d) => d.className.includes('console-divider-b') && d.textContent === 'src/a.ts',
    );
    expect(header).toBeTruthy();
    expect(header?.className).toBe(
      'bg-[var(--ws-editor-bg)] px-3 py-1.5 text-xs font-mono text-cafe-muted console-divider-b truncate',
    );
    expect(header?.children.length).toBe(0);
  });

  it('classic never shows the open-file action even when the prop is passed', async () => {
    writeShellPresentation('classic');
    const onOpenFile = vi.fn();
    await render('thread-1', onOpenFile);
    expect(container.textContent).not.toContain('打开文件');
    expect(container.textContent).not.toContain('Open file');
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('renders the open-file action in English when the shell language is en', async () => {
    const { writeShellLanguage } = await import('@/components/shell/shell-language');
    writeShellLanguage('en');
    const onOpenFile = vi.fn();
    await render('thread-1', onOpenFile);
    const buttons = Array.from(container.querySelectorAll('button')).filter(
      (b) => b.textContent?.trim() === 'Open file',
    );
    expect(buttons.length).toBe(2);
    expect(container.textContent).not.toContain('打开文件');
    writeShellLanguage('zh');
  });
});
