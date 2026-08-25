// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startDocument = vi.hoisted(() => vi.fn());
const cacheControls = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn().mockResolvedValue(undefined),
  refresh: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
}));
vi.mock('@/services/DocumentListenController', () => ({
  documentListenController: { startDocument },
}));
vi.mock('@/services/DocumentCacheController', () => ({ documentCacheController: cacheControls }));

import { extractListenSentences } from '@/lib/listen-mode/markdown-sentences';
import { useChatStore } from '@/stores/chatStore';
import { listenDocumentCacheKey, useListenModeStore } from '@/stores/listenModeStore';
import { WorkspaceFileViewer } from '../WorkspaceFileViewer';

describe('WorkspaceFileViewer listen mode', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    startDocument.mockReset();
    Object.values(cacheControls).forEach((control) => control.mockClear?.());
    useChatStore.setState({ currentProjectPath: '/repo', currentThreadId: 'thread-1' });
    useListenModeStore.setState({ session: null, cacheByDocument: {} });
    container = document.createElement('div');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  });

  async function renderViewer(content = '# 标题\n第一句。第二句。') {
    await act(async () => {
      root.render(
        <WorkspaceFileViewer
          file={{
            path: 'docs/research.md',
            content,
            sha256: 'sha-1',
            size: 24,
            mime: 'text/markdown',
            truncated: false,
          }}
          openFilePath="docs/research.md"
          openTabs={['docs/research.md']}
          canEdit={true}
          editMode={false}
          isMarkdown={true}
          isHtml={false}
          isJsx={false}
          markdownRendered={true}
          htmlPreview={false}
          jsxPreview={false}
          saveError={null}
          scrollToLine={null}
          worktreeId="cat-cafe"
          currentWorktree={{ id: 'cat-cafe', root: '/repo', branch: 'main', head: 'abc' }}
          setOpenFile={vi.fn()}
          closeTab={vi.fn()}
          onCloseCurrentTab={vi.fn()}
          onToggleEdit={vi.fn()}
          onToggleMarkdownRendered={vi.fn()}
          onToggleHtmlPreview={vi.fn()}
          onToggleJsxPreview={vi.fn()}
          onSave={vi.fn()}
          revealInFinder={vi.fn()}
        />,
      );
    });
  }

  async function activateListenSession() {
    const sentences = extractListenSentences('# 标题\n第一句。第二句。');
    await act(async () => {
      useListenModeStore.setState({
        session: {
          identity: { projectPath: '/repo', relativePath: 'docs/research.md', contentDigest: 'sha-1' },
          title: 'research.md',
          worktreeId: 'cat-cafe',
          sentences,
          phase: 'paused',
          currentIndex: 0,
          currentTime: 0,
          duration: 0,
          playbackRate: 1,
          retention: '7d',
          cachedAnchors: [],
          cacheBytes: 0,
          error: null,
        },
      });
    });
  }

  it('starts from the saved position through the F284 Files/detail toolbar', async () => {
    await renderViewer();
    const button = container.querySelector('button[title="从上次位置开始听读"]') as HTMLButtonElement;

    await act(async () => button.click());

    expect(startDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: { projectPath: '/repo', relativePath: 'docs/research.md', contentDigest: 'sha-1' },
        worktreeId: 'cat-cafe',
      }),
      undefined,
    );
  });

  it('starts full-document caching from the rendered Markdown toolbar before listen playback exists', async () => {
    await renderViewer();
    const button = [...container.querySelectorAll('button')].find(({ textContent }) => textContent === '缓存全文');

    await act(async () => button?.click());

    expect(cacheControls.start).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: { projectPath: '/repo', relativePath: 'docs/research.md', contentDigest: 'sha-1' },
        sentences: expect.arrayContaining([expect.objectContaining({ text: '第一句。' })]),
      }),
    );
    expect(startDocument).not.toHaveBeenCalled();
  });

  it('shows the server-projected partial cache as a resumable toolbar action', async () => {
    await renderViewer();
    await act(async () => {
      const identity = { projectPath: '/repo', relativePath: 'docs/research.md', contentDigest: 'sha-1' };
      useListenModeStore.setState({
        cacheByDocument: {
          [listenDocumentCacheKey(identity)]: {
            identity,
            cachedAnchors: ['heading-0'],
            cacheBytes: 100,
            totalSentences: 3,
            active: false,
            error: null,
          },
        },
      });
    });

    expect(container.textContent).toContain('继续缓存 1/3');
  });

  it('starts from the exact inline sentence clicked by the user', async () => {
    await renderViewer();
    await activateListenSession();
    const sentence = container.querySelector('[aria-label="从第 3 句开始听读"]') as HTMLElement;

    await act(async () => sentence.click());

    expect(startDocument).toHaveBeenLastCalledWith(expect.anything(), 2);
  });

  it('keeps rendered Markdown inert until this document has an active listen session', async () => {
    await renderViewer();

    expect(container.querySelector('[data-listen-sentence-anchor]')).toBeNull();
    expect(container.querySelector('[aria-label="从第 1 句开始听读"]')).toBeNull();

    await activateListenSession();

    expect(container.querySelector('[aria-label="从第 1 句开始听读"]')).not.toBeNull();
  });

  it('hides leading YAML frontmatter from the rendered reading surface', async () => {
    await renderViewer('---\nfeature_ids: [F167]\nowner: opus\n---\n\n# 可见标题\n正文。');

    expect(container.textContent).toContain('可见标题');
    expect(container.textContent).toContain('正文。');
    expect(container.textContent).not.toContain('feature_ids');
    expect(container.textContent).not.toContain('owner: opus');
  });
});
