import type { ContentModificationDetailView } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModificationMediaCompare } from '../media-compare/ModificationMediaCompare';
import { compareAsset } from './media-compare.fixture';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:compare');
      static revokeObjectURL = vi.fn();
    },
  );
  mocks.apiFetch.mockReset();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function detail(prepared = true): ContentModificationDetailView {
  return {
    stage: 'queued',
    candidates: [],
    acceptances: [],
    record: {
      requestId: 'request-one',
      ownerUserId: 'operator',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      progress: prepared ? { prepared: { kind: 'media', contentRef: 'published-pair', ownerRevision: 1 } } : {},
      payload: {
        operationId: '6e450cec-7617-4184-9221-3d6e88c93a66',
        threadId: 'original-thread',
        targetCatId: 'codex61-sol',
        source: {
          kind: 'workspace',
          locator: { worktreeId: 'work', path: 'media.png' },
          reviewId: 'workspace-review',
          expectedReviewRevision: 1,
          expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
        },
        intent: { body: '返回候选' },
      },
    },
  };
}
async function render(kind: 'image' | 'video' = 'image', prepared = true) {
  await act(async () =>
    root.render(
      <ModificationMediaCompare
        view={detail(prepared)}
        candidate={{
          kind: 'media',
          candidateRef: 'candidate:2',
          authorCatId: 'codex61-sol',
          asset: compareAsset(2, kind),
          responses: [],
        }}
      />,
    ),
  );
}
it.each([
  'image',
  'video',
] as const)('retains the independently authorized %s candidate when original metadata is 404', async (kind) => {
  mocks.apiFetch.mockResolvedValue(new Response('', { status: 404 }));
  await render(kind);
  const media = container.querySelector(kind === 'image' ? 'img' : 'video');
  expect(media).not.toBeNull();
  expect(media?.getAttribute('src')).toBe('http://api.test/api/content-publications/published-pair/media/2');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('原版');
});
it('shows the current candidate while the original metadata request is pending', async () => {
  mocks.apiFetch.mockImplementation(() => new Promise<Response>(() => {}));
  await render();
  expect(container.querySelector('img')).not.toBeNull();
});
it('shows the candidate when the original identity is absent without inventing a source request', async () => {
  await render('image', false);
  expect(container.querySelector('img')).not.toBeNull();
  expect(mocks.apiFetch).not.toHaveBeenCalled();
});
it('uses fixed human copy for malformed original metadata without exposing Zod internals', async () => {
  mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ asset: { privateDiagnostic: 'internal-secret' } })));
  await render();
  expect(container.querySelector('img')).not.toBeNull();
  expect(container.textContent).not.toMatch(/Zod|invalid_type|internal-secret|"path"/);
});

it.each([
  ['image', 404],
  ['video', 500],
] as const)('retains the independent %s candidate when valid original metadata has unreadable bytes (%s)', async (kind, status) => {
  mocks.apiFetch.mockImplementation(async (path: string) => {
    if (path.includes('?ownerRevision=')) return new Response(JSON.stringify({ asset: compareAsset(1, kind) }));
    return new Response(new Blob(['media']), { status: path.endsWith('/media/1') ? status : 200 });
  });
  await render(kind);
  const candidate = container.querySelector(kind === 'image' ? 'img' : 'video');
  expect(candidate?.getAttribute('src')).toBe('http://api.test/api/content-publications/published-pair/media/2');
  expect(container.querySelectorAll('figure')).toHaveLength(0);
});

it('keeps the candidate visible while valid original metadata is waiting for pair bytes', async () => {
  mocks.apiFetch.mockImplementation(async (path: string) => {
    if (path.includes('?ownerRevision=')) return new Response(JSON.stringify({ asset: compareAsset(1) }));
    return new Promise<Response>(() => {});
  });
  await render();
  expect(container.querySelector('img')?.getAttribute('src')).toBe(
    'http://api.test/api/content-publications/published-pair/media/2',
  );
});

it('keeps the candidate visible when the original and candidate media types cannot be compared', async () => {
  mocks.apiFetch.mockImplementation(async (path: string) =>
    path.includes('?ownerRevision=')
      ? new Response(JSON.stringify({ asset: compareAsset(1, 'image') }))
      : new Response(new Blob(['media'])),
  );
  await render('video');
  expect(container.querySelector('video')?.getAttribute('src')).toBe(
    'http://api.test/api/content-publications/published-pair/media/2',
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('两版暂无法核对');
});

it.each([
  'image',
  'video',
] as const)('retains the independent %s candidate after original decode failure', async (kind) => {
  mocks.apiFetch.mockImplementation(async (path: string) =>
    path.includes('?ownerRevision=')
      ? new Response(JSON.stringify({ asset: compareAsset(1, kind) }))
      : new Response(new Blob(['media'])),
  );
  await render(kind);
  const original = container.querySelector(`figure[aria-label="原版"] ${kind === 'image' ? 'img' : 'video'}`)!;
  expect(original).not.toBeNull();
  act(() => original.dispatchEvent(new Event('error')));
  const candidate = container.querySelector(kind === 'image' ? 'img' : 'video');
  expect(candidate?.getAttribute('src')).toBe('http://api.test/api/content-publications/published-pair/media/2');
});
