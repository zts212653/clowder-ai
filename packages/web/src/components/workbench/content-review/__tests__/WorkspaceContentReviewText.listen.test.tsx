import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ListenModePlayer } from '@/components/listen-mode/ListenModePlayer';
import { extractListenSentences } from '@/lib/listen-mode/markdown-sentences';
import { useChatStore } from '@/stores/chatStore';
import { useListenModeStore } from '@/stores/listenModeStore';
import { WorkspaceContentReviewText } from '../WorkspaceContentReviewText';

const controls = vi.hoisted(() => ({ startDocument: vi.fn() }));
vi.mock('@/services/DocumentListenController', () => ({ documentListenController: controls }));
vi.mock('@/services/DocumentCacheController', () => ({
  documentCacheController: {
    refresh: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
  },
}));
const text = '---\ntitle: 原文\n---\n# 标题\n\n第一句。第二句。';
const sentences = extractListenSentences(text);
let container: HTMLDivElement, root: Root;
const scroll = vi.fn();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useChatStore.setState({ currentProjectPath: '/repo', workspaceOpenFilePath: null });
  useListenModeStore.setState({
    session: {
      identity: { projectPath: '/repo', relativePath: 'notes.md', contentDigest: 'a'.repeat(64) },
      title: 'notes.md',
      worktreeId: 'work',
      sentences,
      phase: 'paused',
      currentIndex: 2,
      currentTime: 0,
      duration: 0,
      playbackRate: 1,
      retention: '7d',
      cachedAnchors: [],
      cacheBytes: 0,
      error: null,
    },
    cacheByDocument: {},
  });
  scroll.mockClear();
  controls.startDocument.mockClear();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useListenModeStore.setState({ session: null });
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});
async function render(revision = `sha256:${'a'.repeat(64)}`) {
  await act(async () =>
    root.render(
      <WorkspaceContentReviewText
        text={text}
        markdown
        locator={{ worktreeId: 'work', path: 'notes.md' }}
        revision={revision}
        onQuoteSelected={vi.fn()}
      />,
    ),
  );
}
it('the common text landing restores the exact playing sentence and keeps native listening controls', async () => {
  await render();
  const active = container.querySelector('[data-listen-sentence-anchor][aria-current="true"]');
  expect(active?.getAttribute('data-listen-sentence-anchor')).toBe(sentences[2]!.anchor);
  expect(scroll.mock.contexts).toContain(active);
  expect(container.textContent).toContain('听读');
  expect(container.textContent).toContain('缓存全文');
  expect(controls.startDocument).not.toHaveBeenCalled();
});
it('manual reading suspends automatic following until the user returns to the current sentence', async () => {
  await render();
  await act(async () =>
    container
      .querySelector('[data-testid="workspace-content-review-text"]')!
      .dispatchEvent(new WheelEvent('wheel', { bubbles: true })),
  );
  scroll.mockClear();
  await act(async () => useListenModeStore.setState((state) => ({ session: { ...state.session!, currentIndex: 1 } })));
  expect(scroll).not.toHaveBeenCalled();
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === '回到当前句');
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(scroll.mock.contexts).toContain(container.querySelector('[aria-current="true"]'));
});
it('a changed document never receives the old playback anchor or a fabricated exact position', async () => {
  await render(`sha256:${'b'.repeat(64)}`);
  expect(container.querySelector('[aria-current="true"]')).toBeNull();
  expect(scroll).not.toHaveBeenCalled();
  expect(container.textContent).toContain('听读的是此文档的旧版本');
});
it('the player return action re-centers the current sentence after manual reading in the same mounted page', async () => {
  await act(async () =>
    root.render(
      <>
        <ListenModePlayer />
        <WorkspaceContentReviewText
          text={text}
          markdown
          locator={{ worktreeId: 'work', path: 'notes.md' }}
          revision={`sha256:${'a'.repeat(64)}`}
          onQuoteSelected={vi.fn()}
        />
      </>,
    ),
  );
  await act(async () =>
    container
      .querySelector('[data-testid="workspace-content-review-text"]')!
      .dispatchEvent(new WheelEvent('wheel', { bubbles: true })),
  );
  scroll.mockClear();
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === '返回正文')!;
  expect(button).toBeDefined();
  await act(async () => button.click());
  expect(scroll.mock.contexts).toContain(container.querySelector('[data-listen-sentence-anchor][aria-current="true"]'));
});
