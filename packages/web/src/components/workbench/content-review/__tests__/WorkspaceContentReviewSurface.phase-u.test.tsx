import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceContentReviewSurface } from '../WorkspaceContentReviewSurface';
import { mediaView, videoDiscussionView, view } from './WorkspaceContentReviewSurface.fixture';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.apiFetch.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

// These entry-level REDs do not establish admission, execution, or writeback PASS.
it.each([
  ['PNG', mediaView],
  ['MP4', videoDiscussionView],
  ['text', view],
] as const)('Phase U: a writable ordinary %s can begin an explicit modification request', async (_kind, makeView) => {
  const initial = makeView();
  if (initial.review.source.kind !== 'text' && initial.review.source.kind !== 'media')
    throw new Error('This check requires an ordinary file fixture');
  const path = initial.review.source.locator.path;
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/workspace/content-reviews/prepare' || url.endsWith(initial.review.reviewId))
      return new Response(JSON.stringify(initial));
    throw new Error(`unexpected route: ${url}`);
  });
  await act(async () => {
    root.render(
      <WorkspaceContentReviewSurface
        worktreeId="worktree-a"
        path={path}
        sourceText="A unique source quote."
        sourceTextRevision={initial.review.source.revision}
        onBack={vi.fn()}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(container.textContent).not.toContain('正在打开作品');
  const request = container.querySelector<HTMLButtonElement>('[data-testid="content-modification-entry"]');
  expect(request, 'writable content must expose the accepted modification journey').not.toBeNull();
  expect(request?.disabled).toBe(false);
});

// Alpha 2026-09-24: a `.png` whose bytes are JPEG is refused by prepare with 415. The page must end there
// and say why, instead of an error line sitting under a spinner that never finishes.
it('an owner refusal of the file type ends the opening with the reason instead of still loading', async () => {
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/workspace/content-reviews/prepare')
      return new Response(JSON.stringify({ error: { code: 'unsupported_media' } }), { status: 415 });
    throw new Error(`unexpected route: ${url}`);
  });
  await act(async () => {
    root.render(
      <WorkspaceContentReviewSurface
        worktreeId="worktree-a"
        path="assets/avatars/opus.png"
        sourceText=""
        sourceTextRevision="sha256:unused"
        onBack={vi.fn()}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('实际内容不是可协作的图片或视频格式');
  expect(container.textContent).not.toContain('正在打开作品');
  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
});
