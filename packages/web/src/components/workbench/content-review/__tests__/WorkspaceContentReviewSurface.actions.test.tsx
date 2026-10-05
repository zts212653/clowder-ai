import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceContentReviewSurface } from '../WorkspaceContentReviewSurface';
import { mediaView, reviewId, revision, view } from './WorkspaceContentReviewSurface.fixture';

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

it('saves a visual text mark through the ordinary review action endpoint instead of a Task review action', async () => {
  const initial = mediaView();
  const saved = mediaView();
  saved.review.revision = 2;
  saved.review.visualMarks = [
    {
      drawing: {
        id: 'saved-ordinary-text',
        kind: 'text',
        at: { x: 32, y: 48 },
        text: '保留暖光',
        color: '#d04a3a',
        strokeWidth: 4,
        fontSize: 18,
      },
      baseRevision: revision,
      author: { kind: 'human', actorId: 'operator' },
      createdAt: '2026-09-18T00:00:00.000Z',
      state: 'active',
    },
  ];
  Object.assign(saved, { visualMarkResolutions: [{ markId: 'saved-ordinary-text', status: 'attached' }] });
  let actionSaved = false;
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(initial));
    if (url === `/api/workspace/content-reviews/${reviewId}/actions`) {
      actionSaved = true;
      return new Response(JSON.stringify({}));
    }
    if (url === `/api/workspace/content-reviews/${reviewId}`)
      return new Response(JSON.stringify(actionSaved ? saved : initial));
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
  const markup = container.querySelector<HTMLButtonElement>('[data-mode="markup"]');
  await act(async () => markup?.click());
  const textTool = container.querySelector<HTMLButtonElement>('[aria-label="文字"]');
  await act(async () => textTool?.click());
  const layer = container.querySelector<SVGSVGElement>('[data-testid="review-markup-layer"]');
  if (!layer) throw new Error('markup layer is missing');
  Object.defineProperties(layer, {
    getBoundingClientRect: { configurable: true, value: () => ({ left: 0, top: 0, width: 160, height: 100 }) },
    setPointerCapture: { configurable: true, value: () => undefined },
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: () => undefined },
  });
  const pointer = (type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { pointerId: { value: 1 }, clientX: { value: 32 }, clientY: { value: 48 } });
    return event;
  };
  await act(async () => layer.dispatchEvent(pointer('pointerdown')));
  const input = container.querySelector<HTMLTextAreaElement>('[aria-label="标注文字"]');
  if (!input) throw new Error('inline markup text input is missing');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(input, '保留暖光');
  await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  const save = [...container.querySelectorAll('button')].find((button) => button.textContent === '完成并保存');
  await act(async () => save?.click());

  const action = mocks.apiFetch.mock.calls.find(
    ([url]) => url === `/api/workspace/content-reviews/${reviewId}/actions`,
  );
  expect(action).toBeTruthy();
  expect(JSON.parse(String(action?.[1]?.body))).toMatchObject({
    expectedRevision: 1,
    action: {
      kind: 'add_visual_marks',
      marks: [expect.objectContaining({ kind: 'text', text: '保留暖光', at: { x: 32, y: 48 } })],
    },
  });
  expect(container.querySelector('[data-testid="review-saved-markup-layer"]')).not.toBeNull();
  expect(
    container.querySelector('[data-testid="review-saved-mark"][data-mark-id="saved-ordinary-text"]'),
  ).not.toBeNull();
});

it('replies to and resolves an ordinary-file annotation through F309 review actions', async () => {
  const initial = mediaView();
  initial.review.revision = 2;
  initial.review.annotations = [
    {
      id: 'ordinary-action-comment',
      anchor: { baseRevision: revision, anchor: { kind: 'image-point', x: 32, y: 48 } },
      body: 'Please review this ordinary file.',
      author: { kind: 'human', actorId: 'operator' },
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
      state: 'open',
      replies: [],
    },
  ];
  Object.assign(initial, { annotationResolutions: [{ annotationId: 'ordinary-action-comment', status: 'attached' }] });
  const replied = structuredClone(initial);
  replied.review.revision = 3;
  replied.review.annotations = replied.review.annotations.map((annotation) => ({
    ...annotation,
    replies: [
      {
        id: 'ordinary-action-reply',
        body: 'This is a persisted file discussion reply.',
        author: { kind: 'human', actorId: 'operator' },
        createdAt: '2026-09-18T00:01:00.000Z',
        updatedAt: '2026-09-18T00:01:00.000Z',
      },
    ],
  }));
  const resolved = structuredClone(replied);
  resolved.review.revision = 4;
  resolved.review.annotations = resolved.review.annotations.map((annotation) => ({ ...annotation, state: 'resolved' }));
  let actions = 0;
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(initial));
    if (url === `/api/workspace/content-reviews/${reviewId}/actions`) {
      actions += 1;
      return new Response(JSON.stringify({}));
    }
    if (url === `/api/workspace/content-reviews/${reviewId}`)
      return new Response(JSON.stringify(actions === 1 ? replied : resolved));
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
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="打开作品讨论"]')?.click());
  const textarea = container.querySelector<HTMLTextAreaElement>('[aria-label="回复批注 ordinary-action-comment"]');
  if (!textarea) throw new Error('ordinary discussion reply input is missing');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, 'This is a persisted file discussion reply.');
  await act(async () => textarea.dispatchEvent(new Event('input', { bubbles: true })));
  const reply = [...container.querySelectorAll('button')].find((button) => button.textContent === '回复');
  await act(async () => reply?.click());
  await act(async () => Promise.resolve());

  const resolve = [...container.querySelectorAll('button')].find((button) => button.textContent === '标为已解决');
  await act(async () => resolve?.click());
  await act(async () => Promise.resolve());

  const actionCalls = mocks.apiFetch.mock.calls.filter(
    ([url]) => url === `/api/workspace/content-reviews/${reviewId}/actions`,
  );
  expect(actionCalls).toHaveLength(2);
  expect(JSON.parse(String(actionCalls[0]?.[1]?.body))).toMatchObject({
    expectedRevision: 2,
    action: {
      kind: 'reply',
      annotationId: 'ordinary-action-comment',
      body: 'This is a persisted file discussion reply.',
    },
  });
  expect(JSON.parse(String(actionCalls[1]?.[1]?.body))).toMatchObject({
    expectedRevision: 3,
    action: { kind: 'set_annotation_state', annotationId: 'ordinary-action-comment', state: 'resolved' },
  });
  expect(container.textContent).toContain('已解决');
});
