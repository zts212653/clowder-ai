import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveArtifactReviewTarget } from '../artifact-review-surface';
import { contentContextSelectionKey, PublicationLandingResolver } from '../PublicationLandingResolver';
import { createPublicationSurface, type PublicationTarget } from '../publication-surface';

const mock = vi.hoisted(() => ({ apiFetch: vi.fn(), mount: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mock.apiFetch(...args) }));
const work = { contentRef: `work:${'a'.repeat(64)}`, ownerRevision: 1 };
const context = {
  reviewId: `review-${'b'.repeat(64)}`,
  round: 1,
  taskId: 'task-original',
  threadId: 'thread-original',
  title: '修改原片',
  taskTitle: '修改原片',
  threadTitle: '制片对话',
  targetCatId: 'sonnet',
  targetName: '布偶猫',
  ledgerRef: `workspace-review-${'c'.repeat(64)}`,
  state: 'changes_requested',
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  mock.apiFetch.mockReset();
  mock.mount.mockReset();
  mock.apiFetch.mockImplementation(
    async () => new Response(JSON.stringify({ ownerUserId: 'operator', contexts: [context] })),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
function Work({ revision }: { revision: number }) {
  useEffect(() => mock.mount(), []);
  return <div data-testid="video-work">作品版本 {revision} · 故事线 · 素材</div>;
}
async function render(target: PublicationTarget, resolved = vi.fn()) {
  await act(async () => {
    root.render(
      <PublicationLandingResolver
        sourceSurface={createPublicationSurface({ ...target, title: '真实交片' })}
        target={target}
        onResolved={resolved}
        onBack={() => {}}
      >
        <Work revision={target.ownerRevision} />
      </PublicationLandingResolver>,
    );
    for (let n = 0; n < 12; n++) await Promise.resolve();
  });
  return resolved;
}

// Native Sonnet's fixed v1/v2 cards opened the original Task review instead of the video desk.
// Neither a shared ledger nor a browser's remembered Task choice changes what a Work card names.
it.each([
  null,
  context.reviewId,
  `review-${'d'.repeat(64)}`,
])('a fixed Work entry keeps the video desk and offers the original review (saved selection %s)', async (saved) => {
  if (saved) localStorage.setItem(contentContextSelectionKey('operator', work.contentRef), saved);
  const resolved = await render(work);
  expect(resolved).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="video-work"]')?.textContent).toContain('作品版本 1');
  expect(mock.mount).toHaveBeenCalledTimes(1);
  const review = container.querySelector<HTMLButtonElement>('[aria-label="关联的任务审阅"] button');
  expect(review?.textContent).toContain('修改原片');
  if (!review) throw new Error('Original review action missing');
  await act(async () => review.click());
  expect(resolveArtifactReviewTarget(resolved.mock.calls[0]?.[0])).toEqual({
    reviewId: context.reviewId,
    threadId: context.threadId,
    round: 1,
  });
});

it('opening another fixed Work version preserves that version through context refresh', async () => {
  await render(work);
  const resolved = await render({ ...work, ownerRevision: 2 });
  expect(mock.mount).toHaveBeenCalledTimes(2);
  await act(async () => {
    window.dispatchEvent(new Event('cat-cafe:artifact-review-changed'));
    for (let n = 0; n < 12; n++) await Promise.resolve();
  });
  expect(resolved).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="video-work"]')?.textContent).toContain('作品版本 2');
  expect(mock.mount, 'context refresh does not remount the selected version').toHaveBeenCalledTimes(2);
});

it('an explicitly bound Work receipt enters its exact original review', async () => {
  const resolved = await render({ ...work, reviewId: context.reviewId });
  expect(resolveArtifactReviewTarget(resolved.mock.calls[0]?.[0])?.reviewId).toBe(context.reviewId);
  expect(container.querySelector('[data-testid="video-work"]')).toBeNull();
});

it('an unavailable bound Work review does not fall back to the video desk or another review', async () => {
  const resolved = await render({ ...work, reviewId: `review-${'e'.repeat(64)}` });
  expect(resolved).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('所属的审阅当前不可访问');
  expect(container.querySelector('[data-testid="video-work"]')).toBeNull();
  expect(container.querySelector('[aria-label="关联的任务审阅"]')).toBeNull();
});
