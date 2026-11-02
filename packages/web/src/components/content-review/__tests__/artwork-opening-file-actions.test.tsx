import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Lightbox } from '@/components/Lightbox';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { ThreadComposerHost } from '@/components/thread-chat/ThreadComposerHost';
import { mediaView } from '@/components/workbench/content-review/__tests__/WorkspaceContentReviewSurface.fixture';
import { ContentLandingHeader } from '@/components/workbench/content-review/ContentLandingHeader';
import { createFilePreviewSurface } from '@/components/workbench/real-surface-adapters';
import { ArtworkLightboxHost } from '../ArtworkLightboxHost';
import { ArtworkLightboxProvider, type FloatingArtwork, useArtworkLightboxScope } from '../ArtworkLightboxScope';
import { ArtworkOpeningPreview } from '../ArtworkOpeningPreview';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), copy: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3102',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
const path = 'docs/plans/assets/memory-delivery-roadmap/construction-map.png';
const canonical = `f063_root_v1_${'a'.repeat(64)}`;
const work: FloatingArtwork = {
  title: '施工图',
  alt: '施工图',
  mediaType: 'image',
  url: `http://localhost:3102/api/workspace/file/raw?${new URLSearchParams({ worktreeId: 'cat-cafe', path })}`,
  surface: createFilePreviewSurface({ worktreeId: 'cat-cafe', path }),
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  writeShellPresentation('v2');
  writeShellLanguage('zh');
  mocks.apiFetch.mockReset();
  mocks.copy.mockReset();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.copy } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  localStorage.clear();
});
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.getAttribute('aria-label') === label || b.textContent?.trim().startsWith(label),
  );

it('keeps authenticated file actions in one header while the owner is still opening', async () => {
  const called: string[] = [];
  mocks.apiFetch.mockImplementation(async (url: string) => {
    called.push(url);
    return new Response(
      JSON.stringify({ local: true, path: '/original/construction-map.png', filename: 'construction-map.png' }),
    );
  });
  await act(async () =>
    root.render(
      <Lightbox url={work.url} alt={work.alt} onClose={() => {}} composerSlot={<div />}>
        <ArtworkOpeningPreview work={{ ...work, surface: null, pending: true }}>
          <ContentLandingHeader title={work.title} />
        </ArtworkOpeningPreview>
      </Lightbox>,
    ),
  );
  expect(document.querySelector('[data-testid="artwork-chat-preview"]')).not.toBeNull();
  expect(button('下载')).toBeDefined();
  expect(button('作品更多操作')).toBeDefined();
  await act(async () => button('作品更多操作')!.click());
  expect(button('在 Finder 中显示')).toBeDefined();
  expect(button('用默认应用打开')).toBeDefined();
  await act(async () => button('复制路径')!.click());
  expect(mocks.copy).toHaveBeenCalledWith('/original/construction-map.png');
  expect(called).toEqual([expect.stringContaining('/api/workspace/file/raw/file-info?')]);
  expect(document.querySelectorAll('[data-testid="artwork-header"]')).toHaveLength(1);
});

it.each([
  '下载',
  '作品更多操作',
  '原输入框',
])('keeps one action row and %s focus through delayed owner handoff', async (focus) => {
  const view = mediaView();
  if (view.review.source.kind !== 'media') throw new Error('media fixture');
  view.review.source.locator = { worktreeId: canonical, path };
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/workspace/resolve-file-source')
      return new Response(JSON.stringify({ kind: 'file', worktreeId: canonical, path }));
    if (url.startsWith('/api/workspace/file?'))
      return new Response(
        JSON.stringify({ path, type: 'binary', mime: 'image/png', content: '', sha256: 'a'.repeat(64) }),
      );
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(view));
    return new Response(JSON.stringify({ items: [], operations: [], annotations: [] }));
  });
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(160);
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(100);
  vi.spyOn(HTMLImageElement.prototype, 'currentSrc', 'get').mockImplementation(function (this: HTMLImageElement) {
    return this.src;
  });
  let decode!: () => void;
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          decode = resolve;
        }),
    ),
  });
  function Entry() {
    const scope = useArtworkLightboxScope();
    return (
      <button type="button" onClick={() => scope?.open(work)}>
        原施工图
      </button>
    );
  }
  await act(async () =>
    root.render(
      <ArtworkLightboxProvider threadId="original-thread">
        <Entry />
        <ThreadComposerHost threadId="original-thread">
          <textarea aria-label="原输入框" defaultValue="原草稿" />
        </ThreadComposerHost>
        <ArtworkLightboxHost />
      </ArtworkLightboxProvider>,
    ),
  );
  await act(async () => button('原施工图')!.click());
  expect(document.querySelector('[data-testid="workspace-content-review-media"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="artwork-chat-preview"]')).not.toBeNull();
  expect(document.querySelectorAll('button[aria-label="作品更多操作"]')).toHaveLength(1);
  const composer = document.querySelector<HTMLTextAreaElement>('textarea');
  const focused = focus === '原输入框' ? composer : button(focus);
  focused!.focus();
  await act(async () => decode());
  expect(document.querySelector('[data-testid="artwork-chat-preview"]')).toBeNull();
  expect(button('作品更多操作')).toBeDefined();
  expect(document.querySelectorAll('button[aria-label="作品更多操作"]')).toHaveLength(1);
  expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
  if (focus === '原输入框') expect(document.activeElement).toBe(composer);
});
