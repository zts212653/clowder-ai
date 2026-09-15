import type { ArtifactReviewView } from '@cat-cafe/shared';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { reviewDraftPrefix, useArtifactReview } from '../useArtifactReview';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

const reviewId = `review-${'c'.repeat(64)}`;
const pendingKey = `${reviewDraftPrefix('operator', reviewId)}pending`;
const initial: ArtifactReviewView = {
  review: {
    version: 1,
    reviewId,
    revision: 1,
    title: '一起审阅封面',
    contentRef: 'cover',
    task: { taskId: 'task-cover', threadId: 'thread-cover', ownerUserId: 'operator', observedRevision: 1 },
    createdAt: '2026-09-07T14:00:00Z',
    updatedAt: '2026-09-07T14:00:00Z',
    rounds: [
      {
        number: 1,
        openedAt: '2026-09-07T14:00:00Z',
        state: 'draft',
        annotations: [],
        responses: [],
        asset: {
          contentRef: 'cover',
          ownerRevision: 1,
          blobDigest: `sha256:${'c'.repeat(64)}`,
          mediaType: 'image/png',
          media: { kind: 'image', width: 100, height: 100 },
          ownerReceiptRef: 'receipt:cover',
          sourcePublication: {
            artifactRef: '/uploads/cover.png',
            sourceRef: 'message:thread-cover:one',
            revision: '1',
          },
        },
      },
    ],
  },
  pendingVersion: false,
  authority: { state: 'current', taskRevision: 1, ownerCatId: 'codex-astra', canWrite: true },
  continuation: {
    taskId: 'task-cover',
    expectedRevision: 1,
    artifactRef: 'content:cover',
    reviewEvidenceRef: 'review:cover',
    ownerCatId: 'codex-astra',
  },
};

let controller: ReturnType<typeof useArtifactReview>;
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
function Probe() {
  controller = useArtifactReview(reviewId);
  return controller.view ? createElement('h1', null, controller.view.review.title) : null;
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(apiFetch).mockResolvedValue(response(initial));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('blocked retry-record access does not discard the freshly authorized server view', async () => {
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Storage is blocked', 'SecurityError');
  });
  await act(async () => root.render(createElement(Probe)));
  expect(container.textContent).toBe(initial.review.title);
  expect(controller.view?.review.revision).toBe(1);
  expect(controller.loading).toBe(false);
  expect(controller.pending).toBeNull();
  await act(async () => {
    expect(await controller.act({ kind: 'submit_feedback', explanation: '先确认旧操作再继续' }, 1)).toBe(false);
  });
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  get.mockRestore();
  vi.mocked(apiFetch).mockResolvedValue(response(initial));
  await act(async () => controller.refresh());
  expect(controller.view?.review.revision).toBe(1);
  expect(controller.error).toBeNull();
});

it.each([
  '{broken-json',
  JSON.stringify({ reviewId: 'unrelated', operationId: 42 }),
])('a malformed retry record is discarded without failing the valid read: %s', async (stored) => {
  localStorage.setItem(pendingKey, stored);
  await act(async () => root.render(createElement(Probe)));
  expect(controller.view?.review.revision).toBe(1);
  expect(controller.pending).toBeNull();
  expect(localStorage.getItem(pendingKey)).toBeNull();
});

it('blocked cleanup of an invalid retry record still leaves the review readable', async () => {
  localStorage.setItem(pendingKey, '{}');
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('Storage is blocked', 'SecurityError');
  });
  await act(async () => root.render(createElement(Probe)));
  expect(container.textContent).toBe(initial.review.title);
  expect(controller.pending).toBeNull();
});

it('a confirmed server write remains successful when local retry cleanup fails', async () => {
  await act(async () => root.render(createElement(Probe)));
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('Storage is blocked', 'SecurityError');
  });
  vi.mocked(apiFetch).mockResolvedValue(response({ view: { ...initial, review: { ...initial.review, revision: 2 } } }));
  await act(async () => {
    expect(
      await controller.act(
        {
          kind: 'annotate',
          annotationId: 'one',
          anchor: { kind: 'image-region', x: 1, y: 1, width: 5, height: 5 },
          body: '标题右移一点',
        },
        1,
      ),
    ).toBe(true);
  });
  expect(controller.view?.review.revision).toBe(2);
  expect(controller.pending).toBeNull();
  vi.mocked(apiFetch).mockResolvedValue(response({ ...initial, review: { ...initial.review, revision: 2 } }));
  await act(async () => controller.refresh());
  expect(controller.pending).toBeNull();
});

it('a scoped server owner event refreshes Task authority without looping on local projection invalidation', async () => {
  await act(async () => root.render(createElement(Probe)));
  vi.mocked(apiFetch).mockClear();
  vi.mocked(apiFetch).mockImplementation(async () =>
    response({
      ...initial,
      authority: { ...initial.authority, state: 'task_closed', taskRevision: 2, canWrite: false },
    }),
  );
  await act(async () => {
    window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
    window.dispatchEvent(
      new CustomEvent('cat-cafe:entrusted-work-projection-invalidated', { detail: { ownerUserId: 'someone-else' } }),
    );
  });
  expect(apiFetch).not.toHaveBeenCalled();
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('cat-cafe:entrusted-work-projection-invalidated', { detail: { ownerUserId: 'operator' } }),
    );
  });
  expect(apiFetch).toHaveBeenCalledOnce();
  expect(controller.view?.authority.state).toBe('task_closed');
});
