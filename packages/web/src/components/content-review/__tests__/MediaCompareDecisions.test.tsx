import type { ArtifactReviewRound, ArtifactReviewView, ContentModificationDetailView } from '@cat-cafe/shared';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentModificationResults } from '../ContentModificationResults';
import { ArtifactMediaCompare } from '../media-compare/ArtifactMediaCompare';
import { ReviewRoundDecision } from '../ReviewRoundDecision';
import { compareAsset } from './media-compare.fixture';

vi.mock('../ReviewActor', () => ({ ReviewActor: () => <span>原审阅者</span> }));
vi.mock('../media-compare/ModificationMediaCompare', () => ({ ModificationMediaCompare: () => <p>原版与候选</p> }));
vi.mock('../media-compare/MediaVersionCompare', () => ({
  MediaVersionCompare: ({ decision }: { decision?: ReactNode }) => <div>原版与候选{decision}</div>,
}));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const base = `sha256:${'a'.repeat(64)}`;
function view(state?: 'applied' | 'conflict' | 'unknown'): ContentModificationDetailView {
  return {
    stage: 'queued',
    record: {
      requestId: 'media-request',
      ownerUserId: 'operator',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      progress: {},
      payload: {
        operationId: '0eaee4a1-0a4e-4aa1-bb99-019843c2ed46',
        threadId: 'origin',
        targetCatId: 'codex61-sol',
        source: {
          kind: 'workspace',
          locator: { worktreeId: 'work', path: 'picture.png' },
          expectedSourceRevision: base,
          reviewId: 'file-review',
          expectedReviewRevision: 1,
        },
        intent: { body: '修改图片' },
      },
    },
    candidates: [
      { kind: 'media', candidateRef: 'candidate:2', authorCatId: 'codex61-sol', asset: compareAsset(2), responses: [] },
    ],
    acceptances: state
      ? [
          {
            acceptance: {
              requestId: 'media-request',
              ownerUserId: 'operator',
              acceptOperationId: 'accept:one',
              candidateRef: 'candidate:2',
              baseRevision: base,
              locator: { worktreeId: 'work', path: 'picture.png' },
              humanReceiptRef: 'human:one',
              fileReceiptRef: 'file:one',
              acceptedAt: 1,
            },
            receipt: {
              receiptRef: 'file:one',
              ownerUserId: 'operator',
              locator: { worktreeId: 'work', path: 'picture.png' },
              baseRevision: base,
              candidateRevision: compareAsset(2).blobDigest,
              requestId: 'media-request',
              candidateRef: 'candidate:2',
              acceptOperationId: 'accept:one',
              state,
              currentRevision: base,
              ...(state === 'applied' ? { writtenRevision: base } : {}),
            },
          },
        ]
      : [],
  };
}
it.each([
  'conflict',
  'unknown',
] as const)('%s retains the candidate without a success claim or a fresh write action', async (state) => {
  const accept = vi.fn();
  await act(async () => root.render(<ContentModificationResults view={view(state)} busy={false} onAccept={accept} />));
  expect(container.textContent).toContain('原版与候选');
  expect(container.textContent).not.toContain('已写回原文件');
  expect(container.querySelector('[data-testid="content-modification-accept"]')).toBeNull();
  expect(accept).not.toHaveBeenCalled();
});
it('makes workspace adopt/reject explicit, and cancellation removes fresh decisions', async () => {
  const accept = vi.fn().mockResolvedValue(undefined),
    reject = vi.fn().mockResolvedValue(undefined);
  const current = view();
  await act(async () =>
    root.render(<ContentModificationResults view={current} busy={false} onAccept={accept} onReject={reject} />),
  );
  expect(accept).not.toHaveBeenCalled();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="content-modification-accept"]')?.click(),
  );
  expect(accept).toHaveBeenCalledWith('candidate:2');
  current.record.control = {
    state: 'cancelled',
    actorId: 'operator',
    cancelledAt: 2,
    receiptRef: 'cancel:one',
    taskResolution: 'closed',
  };
  await act(async () =>
    root.render(<ContentModificationResults view={current} busy={false} onAccept={accept} onReject={reject} />),
  );
  expect(container.querySelector('[data-testid="content-modification-accept"]')).toBeNull();
  expect(container.querySelector('[data-testid="content-modification-reject"]')).toBeNull();
  expect(container.textContent).toContain('原版与候选');
});
it('Task compare uses the original round action and retains an unknown decision draft across close/reopen', async () => {
  const round: ArtifactReviewRound = {
    number: 2,
    asset: compareAsset(2),
    openedAt: '2026-10-02T19:00:00Z',
    state: 'awaiting_human',
    annotations: [],
    responses: [],
  };
  const decide = vi.fn().mockResolvedValue(false);
  const render = (canWrite = true) => (
    <ReviewRoundDecision
      round={round}
      ownerUserId="operator"
      canWrite={canWrite}
      saving={false}
      draftKey="compare:round:2:decision"
      act={decide}
      compact
    />
  );
  await act(async () => root.render(render()));
  await act(async () => {
    const input = container.querySelector('textarea');
    if (!input) throw new Error('missing decision explanation');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, '这一版需要继续调整');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () =>
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === '要求修改')
      ?.click(),
  );
  expect(decide).toHaveBeenCalledWith(
    { kind: 'decide', outcome: 'changes_requested', explanation: '这一版需要继续调整' },
    2,
  );
  await act(async () => root.render(<p>返回</p>));
  await act(async () => root.render(render()));
  expect(container.querySelector('textarea')?.value).toBe('这一版需要继续调整');
  await act(async () => root.render(render(false)));
  expect(container.querySelector('button')).toBeNull();
});

it('keeps original retry visible inside compare when a Task decision receipt is unknown', async () => {
  const stamp = '2026-10-02T19:00:00Z';
  const review: ArtifactReviewView = {
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
        state: 'awaiting_human' as const,
        annotations: [],
        responses: [],
      })),
    },
    authority: { state: 'current', canWrite: true, taskRevision: 1, ownerCatId: 'codex-astra' },
    pendingVersion: false,
    continuation: {
      taskId: 'task-one',
      expectedRevision: 1,
      artifactRef: 'content:published-pair',
      reviewEvidenceRef: 'review:one',
      ownerCatId: 'codex-astra',
    },
  };
  const retry = vi.fn().mockResolvedValue(false);
  const controller = {
    view: review,
    error: '保存结果尚未确认，请重试原操作。',
    loading: false,
    saving: false,
    pending: {
      reviewId: review.review.reviewId,
      expectedRevision: 3,
      expectedTaskRevision: 1,
      operationId: 'original-operation',
      round: 2,
      action: { kind: 'decide' as const, outcome: 'approved' as const, explanation: '保留判断草稿' },
    },
    act: vi.fn().mockResolvedValue(false),
    retry,
    refresh: vi.fn(),
    revokeAccess: vi.fn(),
  };
  await act(async () =>
    root.render(
      <ArtifactMediaCompare
        view={review}
        round={review.review.rounds[1]}
        controller={controller}
        prefix="compare:"
        canWrite={false}
        onClose={vi.fn()}
        onBack={vi.fn()}
      />,
    ),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('保存结果尚未确认');
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === '重试原保存操作');
  expect(button).toBeDefined();
  await act(async () => button?.click());
  expect(retry).toHaveBeenCalledOnce();
  expect(controller.act).not.toHaveBeenCalled();
});
