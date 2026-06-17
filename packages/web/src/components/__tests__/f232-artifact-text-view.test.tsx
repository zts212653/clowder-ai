/**
 * F232 AC-A7 灵魂 — text view 在 panel 内看正文：
 *  - markdown 产物（如 backlog）→ MarkdownContent 渲染正文
 *  - 代码/文本产物 → CodeViewer 渲染
 *  - 内容加载失败 → 降级到「跳回原消息」（fallback）
 */
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { contentState } = vi.hoisted(() => ({
  contentState: {
    value: { content: null as string | null, path: '', isMarkdown: false, loading: false, error: false },
  },
}));

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://test.local' }));
vi.mock('@/hooks/useArtifactContent', () => ({ useArtifactContent: () => contentState.value }));
vi.mock('../MarkdownContent', () => ({
  MarkdownContent: ({ content, basePath, worktreeId }: { content: string; basePath?: string; worktreeId?: string }) =>
    createElement(
      'pre',
      { 'data-md': true, 'data-basepath': basePath ?? '∅', 'data-worktreeid': worktreeId ?? '∅' },
      content,
    ),
}));
vi.mock('../workspace/CodeViewer', () => ({
  CodeViewer: ({ content }: { content: string }) => createElement('pre', { 'data-code': true }, content),
}));

import { ArtifactDetailView } from '../artifacts/ArtifactDetailView';

function renderDetail(artifact: ThreadArtifactDTO, worktreeId: string | null = 'wt1') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      createElement(ArtifactDetailView, {
        artifact,
        worktreeId,
        onBack: () => {},
        onJump: () => {},
      }),
    );
  });
  return { container, root };
}

describe('F232 AC-A7 text view 看正文', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    contentState.value = { content: null, path: '', isMarkdown: false, loading: false, error: false };
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('markdown 产物（backlog）→ MarkdownContent 渲染正文', () => {
    contentState.value = {
      content: '# Backlog\n- item',
      path: 'docs/ROADMAP.md',
      isMarkdown: true,
      loading: false,
      error: false,
    };
    const { container } = renderDetail({
      type: 'file',
      name: 'BACKLOG.md',
      ref: 'docs/ROADMAP.md',
      createdAt: 1,
      catId: null,
      sourceMessageId: null,
    });
    const md = container.querySelector('[data-md]');
    expect(md, 'md 产物应走 MarkdownContent').toBeTruthy();
    expect(md?.textContent).toContain('# Backlog');
  });

  // 云端 round 4 P2：workspace-backed markdown 须传 basePath(path 目录) + worktreeId，
  // 否则 ./assets/x.png、兄弟 .md 等相对引用断链（与 FileContentRenderer 一致）。
  it('workspace-backed markdown → MarkdownContent 收到 basePath(目录) + worktreeId', () => {
    contentState.value = {
      content: '![x](./assets/x.png)',
      path: 'docs/features/foo.md',
      isMarkdown: true,
      loading: false,
      error: false,
    };
    const { container } = renderDetail(
      { type: 'file', name: 'foo.md', ref: 'docs/features/foo.md', createdAt: 1, catId: null, sourceMessageId: null },
      'wt1',
    );
    const md = container.querySelector('[data-md]');
    expect(md?.getAttribute('data-basepath'), 'workspace md 应传 basePath=目录').toBe('docs/features');
    expect(md?.getAttribute('data-worktreeid'), 'workspace md 应传 worktreeId').toBe('wt1');
  });

  it('uploads markdown（有 url）→ MarkdownContent 不传 basePath/worktreeId（无 workspace 上下文）', () => {
    contentState.value = {
      content: '![x](./assets/x.png)',
      path: 'notes.md',
      isMarkdown: true,
      loading: false,
      error: false,
    };
    const { container } = renderDetail(
      { type: 'file', name: 'notes.md', url: '/uploads/notes.md', createdAt: 1, catId: null, sourceMessageId: null },
      'wt1',
    );
    const md = container.querySelector('[data-md]');
    expect(md?.getAttribute('data-basepath'), 'uploads md 不应传 basePath').toBe('∅');
    expect(md?.getAttribute('data-worktreeid'), 'uploads md 不应传 worktreeId').toBe('∅');
  });

  it('代码/文本产物 → CodeViewer 渲染', () => {
    contentState.value = { content: 'const x = 1;', path: 'src/a.ts', isMarkdown: false, loading: false, error: false };
    const { container } = renderDetail({
      type: 'code',
      name: 'a.ts',
      ref: 'src/a.ts',
      createdAt: 1,
      catId: null,
      sourceMessageId: null,
    });
    const code = container.querySelector('[data-code]');
    expect(code, '非 md 文本应走 CodeViewer').toBeTruthy();
    expect(code?.textContent).toContain('const x = 1;');
  });

  it('内容加载失败 → 降级到「跳回原消息」', () => {
    contentState.value = { content: null, path: 'docs/ROADMAP.md', isMarkdown: true, loading: false, error: true };
    const { container } = renderDetail({
      type: 'file',
      name: 'BACKLOG.md',
      ref: 'docs/ROADMAP.md',
      createdAt: 1,
      catId: null,
      sourceMessageId: 'msg-1',
    });
    const jump = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('跳回原消息'));
    expect(jump, '加载失败应降级到跳回原消息').toBeTruthy();
    expect(container.querySelector('[data-md]'), '失败时不应渲染 MarkdownContent').toBeFalsy();
  });

  it('加载中 → 显示加载态', () => {
    contentState.value = { content: null, path: 'docs/ROADMAP.md', isMarkdown: true, loading: true, error: false };
    const { container } = renderDetail({
      type: 'file',
      name: 'BACKLOG.md',
      ref: 'docs/ROADMAP.md',
      createdAt: 1,
      catId: null,
      sourceMessageId: null,
    });
    expect(container.textContent).toContain('加载');
  });
});

describe('F232 P1-1 download view — binary 产物不空白', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('uploads binary（有 url）→ 下载/打开链接（不空白）', () => {
    const { container } = renderDetail(
      {
        type: 'file',
        name: 'report.pdf',
        url: '/uploads/report.pdf',
        createdAt: 1,
        catId: null,
        sourceMessageId: null,
      },
      'wt1',
    );
    const dl = [...container.querySelectorAll('a')].find((a) =>
      a.getAttribute('href')?.includes('/uploads/report.pdf'),
    );
    expect(dl, 'uploads binary 应有下载链接，不空白').toBeTruthy();
  });

  it('repo binary（只有 ref 无 url）→ fallback（不空白，不走 workspace raw 避免 400）', () => {
    const { container } = renderDetail(
      { type: 'file', name: 'report.pdf', ref: 'docs/report.pdf', createdAt: 1, catId: null, sourceMessageId: 'msg-1' },
      'wt1',
    );
    const raw = [...container.querySelectorAll('a')].find((a) =>
      a.getAttribute('href')?.includes('/api/workspace/file/raw'),
    );
    expect(raw, 'repo binary 不应走 workspace raw（非媒体 400）').toBeFalsy();
    expect(container.textContent, 'repo binary 应降级 fallback 不空白').toMatch(/跳回原消息|无内容源|无法/);
  });
});
