import type { ContentModificationReceiptV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveArtifactReviewTarget } from '@/components/workbench/artifact-review-surface';
import {
  contentContextSelectionKey,
  PublicationLandingResolver,
} from '@/components/workbench/PublicationLandingResolver';
import { createPublicationSurface } from '@/components/workbench/publication-surface';
import { useChatStore } from '@/stores/chatStore';
import { ContentModificationReceiptCard } from '../ContentModificationReceiptCard';
import { clearModificationFocus } from '../modification-focus';

// The real chain a receipt takes: the card reads the request, the chat store takes the open request, and the work's
// own resolver decides which review it enters. Only the network is stubbed. A work can be a round of several
// reviews, and the resolver remembers the one the person last chose; a receipt is committed to one of them.
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), resolved: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));

const WORK = `prepared-media:${'a'.repeat(64)}`;
const A = `review-${'a'.repeat(64)}`;
const B = `review-${'b'.repeat(64)}`;
const REQUEST = `f309-modification-${'c'.repeat(64)}`;
const CANDIDATE = 'candidate-from-task-a';
const context = (reviewId: string, taskId: string) => ({
  reviewId,
  round: 2,
  taskId,
  threadId: `thread-${taskId}`,
  title: taskId,
  taskTitle: taskId,
  threadTitle: taskId,
  targetCatId: 'sonnet',
  targetName: '宪宪',
});
const requestDetail = {
  stage: 'queued',
  candidates: [
    { kind: 'media', candidateRef: CANDIDATE, asset: { contentRef: WORK, ownerRevision: 2, mediaType: 'image/png' } },
  ],
  acceptances: [],
  record: {
    requestId: REQUEST,
    ownerUserId: 'operator',
    revision: 2,
    createdAt: 1,
    updatedAt: 2,
    // Committed to review A: the owner bound the request there.
    progress: { review: { reviewId: A, round: 1, receiptRef: 'canonical-bind-a' } },
    payload: {
      source: {
        kind: 'publication',
        contentRef: WORK,
        ownerRevision: 1,
        ledgerRef: 'ledger-a',
        expectedLedgerRevision: 1,
      },
      taskContext: {
        kind: 'media',
        taskId: 'task-a',
        expectedTaskRevision: 1,
        reviewId: A,
        expectedReviewRevision: 1,
        round: 1,
      },
    },
  },
};
const receipt = {
  v: 1,
  requestId: REQUEST,
  sourceMessageId: 'source-a',
  targetCatId: 'sonnet',
  taskId: 'task-a',
  state: 'candidate',
  candidateRef: CANDIDATE,
  receiptRef: 'candidate-receipt-a',
  observedAt: 2,
  followUp: { kind: 'none', reason: 'not_applicable' },
} as ContentModificationReceiptV1;

/** Stands in for the Workbench: it takes the chat store's open request and mounts the work's resolver for it. */
function Host() {
  const request = useChatStore((state) => state.workspaceOpenRequest);
  const target = request?.target.kind === 'publication' ? request.target : null;
  return (
    <>
      <ContentModificationReceiptCard receipt={receipt} messageId="host-receipt-a" getCatById={() => undefined} />
      {target ? (
        <PublicationLandingResolver
          sourceSurface={createPublicationSurface(target)}
          target={target}
          onResolved={mocks.resolved}
          onBack={() => {}}
        >
          <p>作品本身</p>
        </PublicationLandingResolver>
      ) : null}
    </>
  );
}

let root: Root;
let host: HTMLDivElement;
const serve = (contexts: ReturnType<typeof context>[]) =>
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path === `/api/content-modifications/${REQUEST}`) return new Response(JSON.stringify(requestDetail));
    if (path === '/api/content-reviews/resolve')
      return new Response(JSON.stringify({ ownerUserId: 'operator', contexts }));
    throw new Error(`unexpected ${path}`);
  });
const openComparison = () =>
  act(async () => {
    (host.querySelector('button[aria-label="打开对照"]') as HTMLButtonElement).click();
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
  });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  clearModificationFocus();
  mocks.fetch.mockReset();
  mocks.resolved.mockReset();
  useChatStore.setState({ currentThreadId: 'thread-1', workspaceOpenRevision: 6, workspaceOpenRequest: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => {
    clearModificationFocus();
    root.unmount();
  });
  host.remove();
});

it('a receipt committed to review A opens A even though the generic entry remembers the work as review B', async () => {
  serve([context(A, 'task-a'), context(B, 'task-b')]);
  localStorage.setItem(contentContextSelectionKey('operator', WORK), B);
  await act(async () => root.render(<Host />));
  await openComparison();
  expect(mocks.resolved).toHaveBeenCalledTimes(1);
  expect(resolveArtifactReviewTarget(mocks.resolved.mock.calls[0]?.[0])?.reviewId).toBe(A);
});

it('a receipt committed to review A opens A when it is one of several and nothing was ever remembered', async () => {
  serve([context(B, 'task-b'), context(A, 'task-a')]);
  await act(async () => root.render(<Host />));
  await openComparison();
  expect(resolveArtifactReviewTarget(mocks.resolved.mock.calls[0]?.[0])?.reviewId).toBe(A);
  expect(host.querySelector('[aria-label="作品讨论上下文"]')).toBeNull();
});

it('says so in place and enters no sibling when review A no longer holds this version, even if B is remembered', async () => {
  serve([context(B, 'task-b')]);
  localStorage.setItem(contentContextSelectionKey('operator', WORK), B);
  await act(async () => root.render(<Host />));
  await openComparison();
  expect(mocks.resolved).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    '这份修改所属的审阅当前不可访问，或已不再包含这一版；没有改去打开这件作品的其他任务审阅。',
  );
  expect(host.textContent).not.toContain('作品本身');
});
