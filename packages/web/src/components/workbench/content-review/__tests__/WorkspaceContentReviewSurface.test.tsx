import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceContentReviewSurface } from '../WorkspaceContentReviewSurface';
import { mediaView, reviewId, revision, videoDiscussionView, view } from './WorkspaceContentReviewSurface.fixture';

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
  mocks.apiFetch.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(view()));
    if (url === `/api/workspace/content-reviews/${reviewId}/annotations`)
      return new Response(JSON.stringify({ review: view(true).review }));
    if (url === `/api/workspace/content-reviews/${reviewId}`) return new Response(JSON.stringify(view(true)));
    throw new Error(`unexpected route: ${url} ${init?.method ?? 'GET'}`);
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('opens an ordinary image as artwork with revision-bound bytes and no permanent comment form', async () => {
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(mediaView()));
    throw new Error(`unexpected route: ${url}`);
  });
  await act(async () => {
    root.render(
      <WorkspaceContentReviewSurface
        worktreeId="worktree-a"
        path="cover.png"
        sourceText=""
        sourceTextRevision=""
        onBack={vi.fn()}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(container.querySelector('textarea')).toBeNull();
  expect(container.textContent).not.toMatch(/F309|owner-native|Workspace owner/);
  expect(container.querySelector('[aria-label="作品讨论"]')).toBeNull();
  const media = container.querySelector<HTMLImageElement>('[data-testid="workspace-content-review-media"]');
  expect(media?.src).toBe(
    `http://api.test/api/workspace/content-reviews/${reviewId}/media?expectedSourceRevision=${encodeURIComponent(revision)}`,
  );
});

it('projects a persisted ordinary-file media mark and keeps canvas-discussion keyboard focus reversible', async () => {
  const discussion = mediaView();
  discussion.review.revision = 3;
  discussion.review.annotations = [
    {
      id: 'ordinary-media-comment',
      anchor: { baseRevision: revision, anchor: { kind: 'image-point', x: 32, y: 48 } },
      body: 'Please look at this corner.',
      author: { kind: 'human', actorId: 'operator' },
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
      state: 'open',
      replies: [
        {
          id: 'ordinary-media-reply',
          body: 'The reply belongs to this ordinary file, not a Task.',
          author: { kind: 'human', actorId: 'operator' },
          createdAt: '2026-09-18T00:01:00.000Z',
          updatedAt: '2026-09-18T00:01:00.000Z',
        },
      ],
    },
  ];
  discussion.review.visualMarks = [
    {
      drawing: {
        id: 'ordinary-media-mark',
        kind: 'rectangle',
        x: 16,
        y: 24,
        width: 48,
        height: 30,
        color: '#d04a3a',
        strokeWidth: 4,
      },
      baseRevision: revision,
      author: { kind: 'human', actorId: 'operator' },
      createdAt: '2026-09-18T00:00:00.000Z',
      state: 'active',
    },
  ];
  Object.assign(discussion, {
    annotationResolutions: [{ annotationId: 'ordinary-media-comment', status: 'attached' }],
    visualMarkResolutions: [{ markId: 'ordinary-media-mark', status: 'attached' }],
  });
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(discussion));
    throw new Error(`unexpected route: ${url}`);
  });

  await act(async () => {
    root.render(
      <WorkspaceContentReviewSurface
        worktreeId="worktree-a"
        path="cover.png"
        sourceText=""
        sourceTextRevision=""
        onBack={vi.fn()}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.querySelector('[data-testid="review-saved-markup-layer"]')).not.toBeNull();
  expect(
    container.querySelector('[data-testid="review-saved-mark"][data-mark-id="ordinary-media-mark"]'),
  ).not.toBeNull();
  const annotation = container.querySelector<SVGElement>('[data-testid="review-canvas-annotation-mark"]');
  expect(annotation).not.toBeNull();
  if (!annotation) throw new Error('ordinary media annotation mark is missing');
  await act(async () => annotation?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(
    container.querySelector('[data-annotation-id="ordinary-media-comment"][data-active]')?.getAttribute('data-active'),
  ).toBe('true');
  expect(container.textContent).toContain('Please look at this corner.');
  expect(container.textContent).toContain('The reply belongs to this ordinary file, not a Task.');
  const reply = container.querySelector<HTMLTextAreaElement>('textarea');
  if (!reply) throw new Error('reply composer is missing');
  for (const key of [' ', 'Enter']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    await act(async () => reply.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  }
  const thread = container.querySelector<HTMLElement>('li[data-annotation-id="ordinary-media-comment"]');
  expect(document.activeElement).toBe(thread);
  const focusCanvasMark = vi.spyOn(annotation, 'focus');
  await act(async () =>
    thread?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
  );
  expect(focusCanvasMark).toHaveBeenCalledOnce();
});

it('seeks an ordinary MP4 discussion to its attached frame before projecting the active mark', async () => {
  const discussion = videoDiscussionView();
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(discussion));
    throw new Error(`unexpected route: ${url}`);
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  await act(async () => {
    root.render(
      <WorkspaceContentReviewSurface
        worktreeId="worktree-a"
        path="clip.mp4"
        sourceText=""
        sourceTextRevision=""
        onBack={vi.fn()}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  const video = container.querySelector<HTMLVideoElement>('[data-testid="workspace-content-review-media"]');
  if (!video) throw new Error('ordinary video projection is missing');
  let currentTime = 0;
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => currentTime,
    set: (value: number) => {
      currentTime = value;
    },
  });
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="打开作品讨论"]')?.click());
  const locate = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === '已定位',
  );
  await act(async () => locate?.click());

  expect(currentTime).toBe(2.5);
  expect(container.querySelector('[data-testid="review-canvas-annotation-mark"]')).not.toBeNull();

  currentTime = 0;
  await act(async () => video.dispatchEvent(new Event('timeupdate')));
  expect(container.querySelector('[data-testid="review-canvas-annotation-mark"]')).toBeNull();

  await act(async () => locate?.click());

  expect(currentTime).toBe(2.5);
  const annotation = container.querySelector<SVGElement>('[data-testid="review-canvas-annotation-mark"]');
  if (!annotation) throw new Error('ordinary video annotation mark is missing after re-location');
  const focusCanvasMark = vi.spyOn(annotation, 'focus');
  const thread = container.querySelector<HTMLElement>('li[data-annotation-id="ordinary-video-comment"]');
  await act(async () =>
    thread?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
  );
  expect(focusCanvasMark).toHaveBeenCalledOnce();
});
