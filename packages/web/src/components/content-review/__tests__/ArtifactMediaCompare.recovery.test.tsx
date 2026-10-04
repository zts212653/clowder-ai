import type { ArtifactReviewView } from '@cat-cafe/shared';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ArtifactMediaCompare } from '../media-compare/ArtifactMediaCompare';
import { compareAsset } from './media-compare.fixture';

vi.mock('../media-compare/MediaVersionCompare', () => ({
  MediaVersionCompare: ({ decision }: { decision?: ReactNode }) => <div>{decision}</div>,
}));
vi.mock('../ReviewRoundDecision', () => ({ ReviewRoundDecision: () => <p>原决定组件</p> }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function view(state: ArtifactReviewView['authority']['state'] = 'current'): ArtifactReviewView {
  const stamp = '2026-10-02T19:00:00Z';
  return {
    review: {
      version: 2,
      reviewId: 'review-one',
      revision: 3,
      title: '作品',
      contentRef: 'published-pair',
      task: { taskId: 'task-one', threadId: 'thread-one', ownerUserId: 'operator', observedRevision: 1 },
      createdAt: stamp,
      updatedAt: stamp,
      rounds: [1, 2].map((number) => ({
        number,
        asset: compareAsset(number),
        openedAt: stamp,
        state: 'awaiting_human',
        annotations: [],
        responses: [],
      })),
    },
    authority: { state, canWrite: state === 'current', taskRevision: 1, ownerCatId: 'codex-astra' },
    pendingVersion: false,
    continuation: {
      taskId: 'task-one',
      expectedRevision: 1,
      artifactRef: 'content:published-pair',
      reviewEvidenceRef: 'review:one',
      ownerCatId: 'codex-astra',
    },
  };
}
function controller(value: ArtifactReviewView) {
  return {
    view: value,
    error: null,
    loading: false,
    saving: false,
    pending: null,
    act: vi.fn().mockResolvedValue(false),
    retry: vi.fn().mockResolvedValue(false),
    refresh: vi.fn(),
    revokeAccess: vi.fn(),
  };
}
it('shows linked discussion uncertainty and retries its original owner instead of a Task decision', async () => {
  const current = view(),
    owner = controller(current),
    retryPending = vi.fn().mockResolvedValue(undefined);
  await act(async () =>
    root.render(
      <ArtifactMediaCompare
        view={current}
        round={current.review.rounds[1]}
        controller={owner}
        recovery={{ pending: true, busy: false, error: '评论结果未确认', retryPending }}
        prefix="review:"
        canWrite={false}
        onBack={vi.fn()}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toContain('讨论保存结果尚未确认');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('评论结果未确认');
  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === '重试原保存操作');
  await act(async () => retry?.click());
  expect(retryPending).toHaveBeenCalledOnce();
  expect(owner.retry).not.toHaveBeenCalled();
  expect(owner.act).not.toHaveBeenCalled();
});
it('keeps the original authority drift explanation visible inside comparison', async () => {
  const current = view('task_changed');
  await act(async () =>
    root.render(
      <ArtifactMediaCompare
        view={current}
        round={current.review.rounds[1]}
        controller={controller(current)}
        prefix="review:"
        canWrite={false}
        onBack={vi.fn()}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toContain('原任务已有变化，请负责的猫核对后继续；讨论与草稿保留。');
});
