import type { ArtifactReviewAnchor } from '@cat-cafe/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceContentReviewMedia } from '@/components/workbench/content-review/WorkspaceContentReviewMedia';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(
  restoreComment: boolean,
  {
    canWrite = true,
    selected = null,
    discussionFocusRequest = null,
    onOpenDiscussion = vi.fn(),
  }: {
    canWrite?: boolean;
    selected?: ArtifactReviewAnchor | null;
    discussionFocusRequest?: { annotationId: string; requestId: number } | null;
    onOpenDiscussion?: () => void;
  } = {},
) {
  await act(async () =>
    root.render(
      createElement(WorkspaceContentReviewMedia, {
        reviewId: 'review',
        sourceRevision: `sha256:${'b'.repeat(64)}`,
        src: 'blob:retained-image',
        media: { kind: 'image', width: 640, height: 480 },
        annotations: [],
        annotationResolutions: [],
        visualMarks: [],
        visualMarkResolutions: [],
        selected,
        restoreComment,
        composer: createElement('form', { 'aria-label': 'host composer' }),
        activeAnnotationId: null,
        discussionFocusRequest,
        canWrite,
        onAnchorSelected: vi.fn(),
        onAnnotationActive: vi.fn(),
        onSaveVisualMarks: vi.fn(async () => true),
        onDeleteVisualMark: vi.fn(async () => true),
        onOpenDiscussion,
        draftKey: 'review:draft-restore',
      }),
    ),
  );
}

const mode = () => container.querySelector('[data-review-mode]')?.getAttribute('data-review-mode');

it('reopens the comment composer for an unsaved text draft that is present on return', async () => {
  await render(true);
  expect(mode()).toBe('comment');
  expect(container.querySelector('form[aria-label="host composer"]')).not.toBeNull();
});

it('opening a discussion keeps the reader in comment mode with its exit', async () => {
  await render(true);
  expect(mode()).toBe('comment');
  await render(true, { discussionFocusRequest: { annotationId: 'mark', requestId: 1 } });
  expect(mode()).toBe('comment');
  expect(container.querySelector('button[aria-label="退出评论"]')).not.toBeNull();
});

it('the bottom discussion button opens the drawer without leaving comment mode or its chosen position', async () => {
  // Parent Alpha A1: re-anchored onto the latest version, whole image chosen, then the real "讨论" button.
  const onOpenDiscussion = vi.fn();
  const wholeImage: ArtifactReviewAnchor = { kind: 'image-region', x: 0, y: 0, width: 640, height: 480 };
  await render(true, { selected: wholeImage, onOpenDiscussion });
  expect(mode()).toBe('comment');
  expect(container.querySelector('form[aria-label="host composer"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="打开作品讨论"]')?.click());
  expect(onOpenDiscussion).toHaveBeenCalledTimes(1);
  expect(mode()).toBe('comment');
  expect(container.querySelector('button[aria-label="退出评论"]')).not.toBeNull();
  expect(container.querySelector('form[aria-label="host composer"]')).not.toBeNull();
});

it('read-only history starts in view mode even with a retained position', async () => {
  await render(false, { canWrite: false, selected: { kind: 'image-region', x: 10, y: 10, width: 40, height: 30 } });
  expect(mode()).toBe('view');
});

it('an unreadable markup draft gets no drawing layer until it is read again', async () => {
  localStorage.setItem('review:draft-restore', '{unreadable-markup');
  try {
    await render(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-mode="markup"]')?.click());
    expect(mode()).toBe('markup');
    expect(container.querySelector('[data-testid="review-markup-layer"]')).toBeNull();
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === '重新读取草稿');
    expect(retry).toBeDefined();
    localStorage.setItem('review:draft-restore', JSON.stringify({ v: 1, marks: [] }));
    await act(async () => retry?.click());
    expect(container.querySelector('[data-testid="review-markup-layer"]')).not.toBeNull();
  } finally {
    localStorage.removeItem('review:draft-restore');
  }
});

it('a draft restored after mount reopens it once; leaving comment mode afterwards stays the reader’s choice', async () => {
  await render(false);
  expect(mode()).toBe('view');
  await render(true);
  expect(mode()).toBe('comment');
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="退出评论"]')?.click());
  expect(mode()).toBe('view');
  await render(true);
  expect(mode()).toBe('view');
});
