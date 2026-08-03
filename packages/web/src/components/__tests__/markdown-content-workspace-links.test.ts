import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRelativeMdLink, MarkdownContent, resolveRelativePath } from '@/components/MarkdownContent';
import { parseWindowsAbsoluteFileHref, resolveWindowsFileTarget } from '@/components/workspace-md-components';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

Object.assign(globalThis as Record<string, unknown>, { React });

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

/* ── isRelativeMdLink ────────────────────────────────── */
describe('isRelativeMdLink', () => {
  it('returns true for relative .md links', () => {
    expect(isRelativeMdLink('features/F046.md')).toBe(true);
    expect(isRelativeMdLink('../ROADMAP.md')).toBe(true);
    expect(isRelativeMdLink('./notes.mdx')).toBe(true);
  });

  it('returns true for .md links with fragment', () => {
    expect(isRelativeMdLink('README.md#section')).toBe(true);
  });

  it('returns false for absolute URLs', () => {
    expect(isRelativeMdLink('https://example.com/doc.md')).toBe(false);
    expect(isRelativeMdLink('http://example.com/doc.md')).toBe(false);
  });

  it('returns false for root-relative paths', () => {
    expect(isRelativeMdLink('/docs/README.md')).toBe(false);
  });

  it('returns false for non-markdown files', () => {
    expect(isRelativeMdLink('style.css')).toBe(false);
    expect(isRelativeMdLink('image.png')).toBe(false);
    expect(isRelativeMdLink('data.json')).toBe(false);
  });

  it('returns false for undefined/empty', () => {
    expect(isRelativeMdLink(undefined)).toBe(false);
    expect(isRelativeMdLink('')).toBe(false);
  });
});

/* ── resolveRelativePath ─────────────────────────────── */
describe('resolveRelativePath', () => {
  it('resolves simple filename against base dir', () => {
    expect(resolveRelativePath('docs/features', 'F046.md')).toBe('docs/features/F046.md');
  });

  it('resolves parent traversal (..)', () => {
    expect(resolveRelativePath('docs/features', '../ROADMAP.md')).toBe('docs/ROADMAP.md');
  });

  it('resolves multiple parent traversals', () => {
    expect(resolveRelativePath('docs/features/sub', '../../README.md')).toBe('docs/README.md');
  });

  it('resolves dot-slash (./) segments', () => {
    expect(resolveRelativePath('docs', './notes.md')).toBe('docs/notes.md');
  });

  it('strips fragment from relative path', () => {
    expect(resolveRelativePath('docs', 'README.md#section')).toBe('docs/README.md');
  });

  it('handles empty base', () => {
    expect(resolveRelativePath('', 'README.md')).toBe('README.md');
  });

  it('handles nested relative path', () => {
    expect(resolveRelativePath('docs', 'features/F063.md')).toBe('docs/features/F063.md');
  });
});

/* ── MarkdownContent with basePath ──────────────────── */
describe('MarkdownContent workspace link rendering', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({
      currentProjectPath: 'G:/AIwork/clowder-ai/clowder-ai-main',
      workspaceMode: 'approval',
      rightPanelMode: 'status',
      workspaceWorktreeId: 'clowder-ai-main',
      workspaceOpenTabs: [],
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    apiFetchMock.mockReset();
  });

  function render(content: string, basePath?: string): string {
    return renderToStaticMarkup(
      React.createElement(MarkdownContent, { content, disableCommandPrefix: true, basePath }),
    );
  }

  it('renders relative md link as workspace-navigable when basePath is set', () => {
    const html = render('[Feature spec](features/F046.md)', 'docs');
    expect(html).toContain('在工作区中打开');
    expect(html).toContain('docs/features/F046.md');
    // Should NOT have target="_blank" for workspace links
    expect(html).not.toMatch(/target=.*_blank.*在工作区中打开/);
  });

  it('renders external links normally even with basePath', () => {
    const html = render('[GitHub](https://github.com)', 'docs');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('https://github.com');
  });

  it('renders relative md link as external when no basePath', () => {
    const html = render('[Feature spec](features/F046.md)');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('在工作区中打开');
  });

  it('renders a Windows absolute markdown link as workspace-navigable in chat', () => {
    const html = render(
      '[综合报告](G:/AIwork/clowder-ai/worktrees/research-harness/project-research/harness/synthesis.md)',
    );

    expect(html).toContain('在工作区中打开');
    expect(html).not.toContain('target="_blank"');
  });

  it('preserves backslash Windows links and blocks unsafe protocols', () => {
    const fileHtml = render(String.raw`[报告](G:\AIwork\clowder-ai\worktrees\research-harness\synthesis.md:42)`);
    const unsafeHtml = render('[危险链接](javascript:alert(1))');

    expect(fileHtml).toContain('在工作区中打开');
    expect(fileHtml).toContain('synthesis.md:42');
    expect(unsafeHtml).not.toContain('javascript:');
  });

  it('parses browser-normalized Windows paths and line numbers', () => {
    expect(parseWindowsAbsoluteFileHref('/G:/AIwork/clowder-ai/docs/report.md:42')).toEqual({
      path: 'G:/AIwork/clowder-ai/docs/report.md',
      line: 42,
    });
  });

  it('uses the longest worktree root without matching a sibling prefix', () => {
    const target = parseWindowsAbsoluteFileHref('G:/repo/worktrees/feature/docs/report.md');
    if (!target) throw new Error('expected a Windows file target');
    expect(
      resolveWindowsFileTarget(target, [
        { id: 'repo', root: 'G:/repo' },
        { id: 'feature-old', root: 'G:/repo/worktrees/feature-old' },
        { id: 'feature', root: 'G:/repo/worktrees/feature' },
      ]),
    ).toEqual({ worktreeId: 'feature', path: 'docs/report.md', line: null });
  });

  it('opens a Windows absolute link in its owning worktree', async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        worktrees: [
          {
            id: 'clowder-ai-main',
            root: 'G:/AIwork/clowder-ai/clowder-ai-main',
            branch: 'main',
            head: 'abc123',
          },
          {
            id: '25e095_research-harness-landscape-20260801',
            root: 'G:/AIwork/clowder-ai/worktrees/research-harness-landscape-20260801',
            branch: 'research/harness-landscape-20260801',
            head: 'def456',
          },
        ],
      }),
    } as Response);

    await act(async () => {
      root.render(
        React.createElement(MarkdownContent, {
          content:
            '[综合报告](G:/AIwork/clowder-ai/worktrees/research-harness-landscape-20260801/project-research/2026-08-01-coding-agent-harness-landscape/synthesis.md:42)',
          disableCommandPrefix: true,
        }),
      );
    });

    await act(async () => {
      container.querySelector('a')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/workspace/worktrees?repoRoot=G%3A%2FAIwork%2Fclowder-ai%2Fclowder-ai-main',
    );
    expect(useChatStore.getState()).toMatchObject({
      workspaceMode: 'dev',
      rightPanelMode: 'workspace',
      workspaceWorktreeId: '25e095_research-harness-landscape-20260801',
      workspaceOpenFilePath: 'project-research/2026-08-01-coding-agent-harness-landscape/synthesis.md',
      workspaceOpenFileLine: 42,
    });
  });

  it('falls back to the default worktree list when the thread project path is a workspace container', async () => {
    useChatStore.setState({ currentProjectPath: 'G:/AIwork/clowder-ai' });
    apiFetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          worktrees: [{ id: 'api', root: 'G:/AIwork/clowder-ai/clowder-ai-runtime/packages/api' }],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          worktrees: [
            {
              id: 'research-harness-landscape-20260801',
              root: 'G:/AIwork/clowder-ai/worktrees/research-harness-landscape-20260801',
            },
          ],
        }),
      } as Response);

    await act(async () => {
      root.render(
        React.createElement(MarkdownContent, {
          content:
            '[综合报告](G:/AIwork/clowder-ai/worktrees/research-harness-landscape-20260801/project-research/2026-08-01-coding-agent-harness-landscape/synthesis.md)',
          disableCommandPrefix: true,
        }),
      );
    });

    await act(async () => {
      container.querySelector('a')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(apiFetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/workspace/worktrees?repoRoot=G%3A%2FAIwork%2Fclowder-ai',
      '/api/workspace/worktrees',
    ]);
    expect(useChatStore.getState()).toMatchObject({
      workspaceWorktreeId: 'research-harness-landscape-20260801',
      workspaceOpenFilePath: 'project-research/2026-08-01-coding-agent-harness-landscape/synthesis.md',
    });
  });

  it('does not open a default-list worktree outside the current project', async () => {
    useChatStore.setState({
      currentProjectPath: 'G:/other-project',
      workspaceWorktreeId: 'other-project',
    });
    apiFetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ worktrees: [{ id: 'other-project', root: 'G:/other-project' }] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          worktrees: [
            {
              id: 'research-harness-landscape-20260801',
              root: 'G:/AIwork/clowder-ai/worktrees/research-harness-landscape-20260801',
            },
          ],
        }),
      } as Response);

    await act(async () => {
      root.render(
        React.createElement(MarkdownContent, {
          content:
            '[综合报告](G:/AIwork/clowder-ai/worktrees/research-harness-landscape-20260801/project-research/2026-08-01-coding-agent-harness-landscape/synthesis.md)',
          disableCommandPrefix: true,
        }),
      );
    });

    await act(async () => {
      container.querySelector('a')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(apiFetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/workspace/worktrees?repoRoot=G%3A%2Fother-project',
      '/api/workspace/worktrees',
    ]);
    expect(useChatStore.getState()).toMatchObject({
      workspaceWorktreeId: 'other-project',
      workspaceOpenFilePath: null,
      workspaceOpenTabs: [],
    });
  });
});
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
