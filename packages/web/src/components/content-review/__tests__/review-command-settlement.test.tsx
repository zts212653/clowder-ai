import type { ArtifactReviewView } from '@cat-cafe/shared';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useArtifactReview } from '../useArtifactReview';
import { command, draftKey, initial, prefix, REVIEW_ID } from './review-command.fixture';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const pendingKey = `${prefix}pending`;
const originalDraft = JSON.stringify({
  body: command.action.kind === 'annotate' ? command.action.body : '',
  anchor: null,
});
const nextView = { ...initial, review: { ...initial.review, revision: 2 } };
const receipt = {
  reviewId: REVIEW_ID,
  operationId: command.operationId,
  revision: 2,
  outcome: 'applied',
  receiptRef: 'receipt:committed',
  actor: { kind: 'human', actorId: 'operator' },
  createdAt: '2026-10-17T00:00:00Z',
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
let controller: ReturnType<typeof useArtifactReview>;
let resolvePost: (value: Response) => void;
let writing: Promise<boolean>;
function Probe({ source = initial }: { source?: ArtifactReviewView }) {
  controller = useArtifactReview(source.review.reviewId);
  return createElement('div', null, controller.view?.review.title);
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
async function start(savedDraft: string | null = originalDraft) {
  localStorage.setItem(pendingKey, JSON.stringify(command));
  if (savedDraft !== null) localStorage.setItem(draftKey, savedDraft);
  vi.mocked(apiFetch).mockImplementation(async (_url, options) =>
    options?.method === 'POST'
      ? new Promise<Response>((resolve) => {
          resolvePost = resolve;
        })
      : response(initial),
  );
  await act(async () => root.render(createElement(Probe)));
  await act(async () => {
    writing = controller.retry();
  });
}
async function finish(body: unknown = { view: nextView, receipt }, status = 200) {
  let result = false;
  await act(async () => {
    resolvePost(response(body, status));
    result = await writing;
  });
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  return result;
}

it('settles the exact submitted draft after the canonical row retires before its successful response', async () => {
  await start();
  await act(async () => root.render(null));
  await finish();
  expect(localStorage.getItem(pendingKey)).toBeNull();
  expect(localStorage.getItem(draftKey)).toBeNull();
});

it.each(['active', 'retired'])('preserves a replacement retry and draft when the old success is %s', async (state) => {
  await start();
  if (state === 'retired') await act(async () => root.render(null));
  const replacement = JSON.stringify({ ...command, operationId: 'new-operation' });
  localStorage.setItem(pendingKey, replacement);
  expect(await finish()).toBe(false);
  expect(localStorage.getItem(pendingKey)).toBe(replacement);
  expect(localStorage.getItem(draftKey)).toBe(originalDraft);
});

it.each(['active', 'retired'])('preserves the changed submitted-key draft while %s', async (state) => {
  await start();
  if (state === 'retired') await act(async () => root.render(null));
  const saved = JSON.stringify({
    body: '同一个人的草稿',
    anchor: { kind: 'image-region', x: 4, y: 4, width: 8, height: 8 },
  });
  localStorage.setItem(draftKey, saved);
  await finish();
  expect(localStorage.getItem(draftKey)).toBe(saved);
  expect(localStorage.getItem(pendingKey)).toBe(JSON.stringify(command));
});

it('preserves a draft created after a command with no stored draft was sent', async () => {
  await start(null);
  const saved = JSON.stringify({ body: '后来写的新意见', anchor: null });
  localStorage.setItem(draftKey, saved);
  expect(await finish()).toBe(false);
  expect(localStorage.getItem(pendingKey)).toBe(JSON.stringify(command));
  expect(localStorage.getItem(draftKey)).toBe(saved);
});

it('does not settle the old owner after a fresh read switches owners', async () => {
  await start();
  const other = { ...initial, review: { ...initial.review, task: { ...initial.review.task, ownerUserId: 'other' } } };
  vi.mocked(apiFetch).mockResolvedValue(response(other));
  await act(async () => controller.refresh());
  expect(await finish()).toBe(false);
  expect(controller.view?.review.task.ownerUserId).toBe('other');
  expect(localStorage.getItem(pendingKey)).toBe(JSON.stringify(command));
  expect(localStorage.getItem(draftKey)).toBe(originalDraft);
});

const invalid = [
  { view: nextView },
  { view: nextView, receipt: null },
  { view: nextView, receipt: { ...receipt, reviewId: 'other-review' } },
  { view: nextView, receipt: { ...receipt, operationId: 'other-operation' } },
  { view: nextView, receipt: { ...receipt, outcome: 'aborted' } },
  { view: nextView, receipt: { ...receipt, revision: 3 } },
  { view: initial, receipt },
  { view: { ...nextView, authority: null }, receipt },
  { view: { ...nextView, review: { ...nextView.review, reviewId: 'other-review' } }, receipt },
  {
    view: { ...nextView, review: { ...nextView.review, task: { ...initial.review.task, ownerUserId: 'other' } } },
    receipt,
  },
  { view: { review: { reviewId: REVIEW_ID, revision: 2 } }, receipt },
];
it.each(invalid.map((body, index) => ({ body, index })))('does not accept mismatched/malformed success $index', async ({
  body,
}) => {
  await start();
  expect(await finish(body)).toBe(false);
  expect(localStorage.getItem(pendingKey)).toBe(JSON.stringify(command));
  expect(localStorage.getItem(draftKey)).toBe(originalDraft);
  expect(controller.view?.review.revision).toBe(1);
});

it('accepts a replay receipt whose later view still includes its committed revision', async () => {
  await start();
  await act(async () => root.render(null));
  await finish({ view: { ...nextView, review: { ...nextView.review, revision: 3 } }, receipt });
  expect(localStorage.getItem(pendingKey)).toBeNull();
  expect(localStorage.getItem(draftKey)).toBeNull();
});

it('does not install an old view or touch a different review after a route switch', async () => {
  await start();
  const other = { ...initial, review: { ...initial.review, reviewId: 'other-review', title: 'Other review' } };
  vi.mocked(apiFetch).mockResolvedValue(response(other));
  const otherRetry = JSON.stringify({ ...command, reviewId: 'other-review', operationId: 'new-review-operation' });
  localStorage.setItem('cat-cafe:review:operator:other-review:pending', otherRetry);
  await act(async () => root.render(createElement(Probe, { source: other })));
  await finish();
  expect(controller.view?.review.reviewId).toBe('other-review');
  expect(localStorage.getItem('cat-cafe:review:operator:other-review:pending')).toBe(otherRetry);
  expect(localStorage.getItem(pendingKey)).toBeNull();
});

it('never revives revoked access when a previously applied response arrives late', async () => {
  await start();
  await act(async () => controller.revokeAccess());
  // A later mount can have an independently prepared retry; the denied sender cannot clear it.
  localStorage.setItem(pendingKey, JSON.stringify(command));
  localStorage.setItem(draftKey, originalDraft);
  expect(await finish()).toBe(false);
  expect(controller.view).toBeNull();
  expect(localStorage.getItem(pendingKey)).toBe(JSON.stringify(command));
  expect(localStorage.getItem(draftKey)).toBe(originalDraft);
});

it.each([403, 409, 500])('keeps an unmounted retry and draft on unsuccessful response %i', async (status) => {
  await start();
  await act(async () => root.render(null));
  expect(await finish({ error: 'unconfirmed' }, status)).toBe(false);
  expect(localStorage.getItem(pendingKey)).toBe(JSON.stringify(command));
  expect(localStorage.getItem(draftKey)).toBe(originalDraft);
});
