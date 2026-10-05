import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PublicationContentReviewSurface } from '../PublicationContentReviewSurface';
import { mediaView } from './WorkspaceContentReviewSurface.fixture';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
let root: Root, container: HTMLDivElement;
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
});

it('opens a task-free publication through the canonical ledger and pinned owner media, with the full modification entry', async () => {
  const view = mediaView();
  const old = view.review.source;
  if (old.kind !== 'media') throw new Error('expected image fixture');
  const contentRef = `prepared-media:${'e'.repeat(64)}`;
  view.review.source = {
    kind: 'publication',
    revision: old.revision,
    mime: old.mime,
    media: old.media,
    publication: {
      contentRef,
      ownerRevision: 2,
      blobDigest: old.revision,
      ownerReceiptRef: 'media-receipt',
      sourcePublication: {
        artifactRef: '/uploads/cover.png',
        sourceRef: 'message:original:publication',
        revision: '2',
      },
    },
  };
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/content-publications/'))
      return new Response(
        JSON.stringify({
          asset: {
            ...(view.review.source.kind === 'publication' ? view.review.source.publication : {}),
            mediaType: old.mime,
            media: old.media,
          },
          currentOwnerRevision: 2,
        }),
      );
    expect(url).toBe('/api/content-reviews/prepare');
    expect(JSON.parse(String(init?.body)).publication).toEqual({ contentRef, ownerRevision: 2 });
    return new Response(JSON.stringify({ ...view, currentSource: view.review.source }));
  });
  await act(async () => {
    root.render(
      <PublicationContentReviewSurface contentRef={contentRef} ownerRevision={2} title="封面" onBack={vi.fn()} />,
    );
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
  expect(container.querySelector('[data-testid="workspace-content-review-surface"]')).not.toBeNull();
  expect(container.querySelector<HTMLButtonElement>('[data-testid="content-modification-entry"]')?.disabled).toBe(
    false,
  );
  expect(container.querySelector('img')?.getAttribute('src')).toContain(
    `/api/content-publications/${encodeURIComponent(contentRef)}/media/2`,
  );
  expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
});
