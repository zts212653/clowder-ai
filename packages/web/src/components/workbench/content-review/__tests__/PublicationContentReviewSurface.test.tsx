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

it.each([
  'loading',
  'error',
])('keeps the original switch and return usable while publication verification is %s', async (state) => {
  localStorage.setItem('cat-cafe:shell-presentation', 'v2');
  const switched = vi.fn(),
    returned = vi.fn();
  mocks.apiFetch.mockImplementation(async () => {
    if (state === 'loading') return new Promise<Response>(() => {});
    return new Response(JSON.stringify({ error: 'access_denied' }), { status: 403 });
  });
  await act(async () => {
    root.render(
      <PublicationContentReviewSurface
        contentRef={`prepared-media:${'e'.repeat(64)}`}
        ownerRevision={1}
        title="封面"
        onBack={returned}
        leadingAction={<button onClick={switched}>切换原作品</button>}
      />,
    );
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
  const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === text)!;
  await act(async () => button('切换原作品').click());
  await act(async () => button('返回').click());
  expect(switched).toHaveBeenCalledTimes(1);
  expect(returned).toHaveBeenCalledTimes(1);
  expect([...container.querySelectorAll('h2')].map((node) => node.textContent)).toEqual(['封面']);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem('cat-cafe:shell-presentation');
});

it.each([
  'classic',
  'v2',
])('opens a task-free PNG publication through the canonical ledger and pinned media with Chat as its modification entry (%s)', async (shell) => {
  localStorage.setItem('cat-cafe:shell-presentation', shell);
  const onBack = vi.fn();
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
    if (url.endsWith('/file-info')) return new Response(JSON.stringify({ local: false }));
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
      <PublicationContentReviewSurface contentRef={contentRef} ownerRevision={2} title="封面" onBack={onBack} />,
    );
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
  expect(container.querySelector('[data-testid="workspace-content-review-surface"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="content-modification-entry"]')).toBeNull();
  expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
  {
    const more = container.querySelector<HTMLButtonElement>('[aria-label="作品更多操作"]');
    expect(more).not.toBeNull();
    await act(async () => more?.click());
  }
  expect(container.querySelector('[data-testid="workspace-media-chat-whole-work"]')).not.toBeNull();
  expect(container.querySelector('img')?.getAttribute('src')).toContain(
    `/api/content-publications/${encodeURIComponent(contentRef)}/media/2`,
  );
  expect(mocks.apiFetch).toHaveBeenCalledTimes(3);
  expect([...container.querySelectorAll('h2')].map((node) => node.textContent)).toEqual(['封面']);
  expect(
    container.querySelector('select[aria-label="作品版本"]')?.getAttribute('value') ??
      (container.querySelector('select') as HTMLSelectElement)?.value,
  ).toBe('2');
  const back = [...container.querySelectorAll('button')].find((button) => button.textContent === '返回');
  expect(back).toBeDefined();
  await act(async () => back?.click());
  expect(onBack).toHaveBeenCalledTimes(1);
});
