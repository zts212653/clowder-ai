import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveChatWorkspaceDocumentHref } from '@/components/ChatWorkspaceLink';
import { MarkdownContent, transformChatMarkdownUrl } from '@/components/MarkdownContent';
import { useChatStore } from '@/stores/chatStore';

Object.assign(globalThis as Record<string, unknown>, { React, IS_REACT_ACT_ENVIRONMENT: true });

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3004',
  apiFetch: apiFetchMock,
}));

describe('resolveChatWorkspaceDocumentHref', () => {
  it('resolves an absolute project document with a line suffix', () => {
    expect(resolveChatWorkspaceDocumentHref('/work/cat-cafe/docs/guide.md:42', '/work/cat-cafe')).toEqual({
      path: 'docs/guide.md',
      line: 42,
    });
  });

  it('resolves repo-relative and Windows project document paths', () => {
    expect(resolveChatWorkspaceDocumentHref('docs/guide.mdx', '/work/cat-cafe')).toEqual({
      path: 'docs/guide.mdx',
      line: null,
    });
    expect(resolveChatWorkspaceDocumentHref('README.md:42', '/work/cat-cafe')).toEqual({
      path: 'README.md',
      line: 42,
    });
    expect(resolveChatWorkspaceDocumentHref('C:\\work\\cat-cafe\\docs\\guide.md:7', 'C:\\work\\cat-cafe')).toEqual({
      path: 'docs/guide.md',
      line: 7,
    });
  });

  it('decodes URL-escaped spaces in project document paths', () => {
    expect(resolveChatWorkspaceDocumentHref('/work/cat-cafe/docs/My%20Guide.md:8', '/work/cat-cafe')).toEqual({
      path: 'docs/My Guide.md',
      line: 8,
    });
  });

  it('rejects external URLs, paths outside the project, and parent traversal', () => {
    expect(resolveChatWorkspaceDocumentHref('https://example.com/guide.md', '/work/cat-cafe')).toBeNull();
    expect(resolveChatWorkspaceDocumentHref('javascript:guide.md', '/work/cat-cafe')).toBeNull();
    expect(resolveChatWorkspaceDocumentHref('/work/other/guide.md', '/work/cat-cafe')).toBeNull();
    expect(resolveChatWorkspaceDocumentHref('../guide.md', '/work/cat-cafe')).toBeNull();
  });
});

describe('transformChatMarkdownUrl', () => {
  it('restores only file-like Markdown URLs rejected as custom schemes', () => {
    expect(transformChatMarkdownUrl('README.md:42')).toBe('README.md:42');
    expect(transformChatMarkdownUrl('C:\\work\\cat-cafe\\README.md:7')).toBe('C:\\work\\cat-cafe\\README.md:7');
    expect(transformChatMarkdownUrl('javascript:guide.md')).toBe('');
    expect(transformChatMarkdownUrl('file:///tmp/guide.md')).toBe('');
  });
});

describe('MarkdownContent chat document navigation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let rootMounted: boolean;

  beforeEach(() => {
    apiFetchMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    rootMounted = true;
    window.history.replaceState(null, '', '/');
    useChatStore.setState({
      currentThreadId: 'default',
      currentProjectPath: '/home/user/cat-cafe',
      workspaceWorktreeId: 'cat-cafe',
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
      workspaceOpenTabs: [],
      rightPanelMode: 'status',
    });
  });

  afterEach(() => {
    if (rootMounted) act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, '', '/');
    useChatStore.setState({
      currentThreadId: 'default',
      currentProjectPath: 'default',
      workspaceWorktreeId: null,
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
      workspaceOpenTabs: [],
      rightPanelMode: 'status',
    });
  });

  function renderContent(content: string) {
    act(() => {
      root.render(<MarkdownContent content={content} disableCommandPrefix />);
    });
  }

  function renderAndClick(content: string) {
    renderContent(content);
    const action = container.querySelector('button');
    expect(action).toBeTruthy();
    act(() => {
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  it('resolves an absolute project-local link so a previously selected sibling worktree cannot capture it', async () => {
    apiFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          worktreeId: 'cat-cafe',
          path: 'docs/discussions/convergence.md',
          line: 59,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    useChatStore.setState({ workspaceMode: 'recall' });
    renderContent('[收敛文档](/home/user/cat-cafe/docs/discussions/convergence.md:59)');
    useChatStore.setState({ workspaceWorktreeId: 'cat-cafe-sibling' });
    const action = container.querySelector('button');
    await act(async () => {
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    const state = useChatStore.getState();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(state.workspaceWorktreeId).toBe('cat-cafe');
    expect(state.workspaceOpenFilePath).toBe('docs/discussions/convergence.md');
    expect(state.workspaceOpenFileLine).toBe(59);
    expect(state.workspaceMode).toBe('dev');
    expect(state.rightPanelMode).toBe('workspace');
  });

  it('opens a repo-relative named Markdown link in Workspace', () => {
    renderAndClick('[Feature](docs/features/F063-hub-workspace-explorer.md)');

    const state = useChatStore.getState();
    expect(state.workspaceOpenFilePath).toBe('docs/features/F063-hub-workspace-explorer.md');
    expect(state.workspaceOpenFileLine).toBeNull();
    expect(state.rightPanelMode).toBe('workspace');
  });

  it('preserves a bare Markdown filename with a line suffix through the ReactMarkdown pipeline', () => {
    renderAndClick('[README](README.md:42)');

    const state = useChatStore.getState();
    expect(state.workspaceOpenFilePath).toBe('README.md');
    expect(state.workspaceOpenFileLine).toBe(42);
    expect(state.rightPanelMode).toBe('workspace');
  });

  it('resolves an absolute Markdown link from another registered worktree on click', async () => {
    apiFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          worktreeId: 'cat-cafe-self-evolution-worldview',
          path: 'docs/research/self-evolution/README.md',
          line: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    renderContent('[完整文档](/home/user/cat-cafe-self-evolution-worldview/docs/research/self-evolution/README.md:1)');

    expect(container.querySelector('a')).toBeNull();
    const action = container.querySelector('button');
    expect(action).toBeTruthy();
    await act(async () => {
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/api/workspace/resolve-document-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        href: '/home/user/cat-cafe-self-evolution-worldview/docs/research/self-evolution/README.md:1',
      }),
    });
    const state = useChatStore.getState();
    expect(state.workspaceWorktreeId).toBe('cat-cafe-self-evolution-worldview');
    expect(state.workspaceOpenFilePath).toBe('docs/research/self-evolution/README.md');
    expect(state.workspaceOpenFileLine).toBe(1);
  });

  it('decodes an escaped Markdown href before resolving a native absolute path', async () => {
    apiFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          worktreeId: 'cat-cafe-guide',
          path: 'docs/My Guide.md',
          line: 12,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    renderContent('[Guide](/home/user/cat-cafe-guide/docs/My%20Guide.md:12)');

    const action = container.querySelector('button');
    expect(action).toBeTruthy();
    await act(async () => {
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/api/workspace/resolve-document-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        href: '/home/user/cat-cafe-guide/docs/My Guide.md:12',
      }),
    });
  });

  it('strips the real fragment before decoding an encoded hash in a native absolute path', async () => {
    apiFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          worktreeId: 'cat-cafe-guide',
          path: 'docs/guide#draft.md',
          line: 12,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    renderContent('[Guide](/home/user/cat-cafe-guide/docs/guide%23draft.md:12#section)');

    const action = container.querySelector('button');
    expect(action).toBeTruthy();
    await act(async () => {
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/api/workspace/resolve-document-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        href: '/home/user/cat-cafe-guide/docs/guide#draft.md:12',
      }),
    });
  });

  it.each([
    ['original', String.raw`[Guide](\\\\server\share\repo\docs\guide.md:7)`],
    ['encoded', '[Guide](%5C%5Cserver%5Cshare%5Crepo%5Cdocs%5Cguide.md:7)'],
  ])('routes an %s UNC Markdown path through Workspace resolution', async (_encoding, markdown) => {
    apiFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          worktreeId: 'windows-share',
          path: 'docs/guide.md',
          line: 7,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    renderContent(markdown);

    expect(container.querySelector('a')).toBeNull();
    const action = container.querySelector('button');
    expect(action).toBeTruthy();
    await act(async () => {
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/api/workspace/resolve-document-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        href: '//server/share/repo/docs/guide.md:7',
      }),
    });
  });

  it('fails a missing local Markdown path closed instead of opening a browser tab', async () => {
    apiFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Document is not in a registered workspace' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderContent('[Missing](/home/user/other/guide.md)');

    expect(container.querySelector('a')).toBeNull();
    const action = container.querySelector('button');
    expect(action).toBeTruthy();
    await act(async () => {
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法在工作区中打开');
    expect(useChatStore.getState().workspaceOpenFilePath).toBeNull();
  });

  it('keeps external and non-Markdown hrefs as browser links', () => {
    renderContent(
      '[Web](https://example.com/guide.md) [Protocol relative](//example.com/guide.md) [Code](src/index.ts)',
    );

    const anchors = Array.from(container.querySelectorAll('a'));
    expect(anchors).toHaveLength(3);
    expect(anchors.every((anchor) => anchor.target === '_blank')).toBe(true);
    expect(useChatStore.getState().workspaceOpenFilePath).toBeNull();
  });
});
