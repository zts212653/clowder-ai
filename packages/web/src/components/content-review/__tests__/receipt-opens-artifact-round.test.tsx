import type { ContentModificationReceiptV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { ContentModificationReceiptCard } from '../ContentModificationReceiptCard';
import { clearModificationFocus, type ModificationFocus, usePendingModificationFocus } from '../modification-focus';

// A request made on a published work or a Task round has no file to open: the returned version is a round of the
// original review, which the Workspace opens through the publication it belongs to and the round surface compares.
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
const getCatById = (id: string) => (id === 'codex-sol' ? { displayName: '烁烁' } : undefined);

const REQUEST_ID = `f309-modification-${'b'.repeat(64)}`;
const CANDIDATE_REF = 'candidate-round-2';
// The publication coordinate the Workspace opens: the owner's real shape, not any string.
const COVER = `prepared-media:${'a'.repeat(64)}`;
const OTHER = `prepared-media:${'b'.repeat(64)}`;
const NOT_A_FILE = '这份修改的原作品不是文件，暂时无法在这里打开。';
const REVIEW_UNCONFIRMED = '这份修改所属的审阅暂时无法确认，无法打开对照。';
// The review the owner committed the request to, and a sibling that can hold the very same version.
const REVIEW = `review-${'c'.repeat(64)}`;
const SIBLING = `review-${'d'.repeat(64)}`;

const receipt = (
  state: ContentModificationReceiptV1['state'],
  patch: Partial<ContentModificationReceiptV1> = {},
): ContentModificationReceiptV1 =>
  ({
    v: 1,
    requestId: REQUEST_ID,
    sourceMessageId: 'human-source',
    targetCatId: 'codex-sol',
    taskId: 'task-1',
    state,
    candidateRef: CANDIDATE_REF,
    receiptRef: 'receipt-secret',
    observedAt: 1,
    followUp: { kind: 'none', reason: 'not_applicable' },
    ...patch,
  }) as ContentModificationReceiptV1;

const mediaCandidate = (candidateRef: string, contentRef: string, ownerRevision: number) => ({
  kind: 'media',
  candidateRef,
  asset: { contentRef, ownerRevision, mediaType: 'image/png' },
  authorCatId: 'codex-sol',
  responses: [],
});
const publicationSource = {
  kind: 'publication',
  contentRef: COVER,
  ownerRevision: 1,
  ledgerRef: 'ledger-1',
  expectedLedgerRevision: 3,
};
const inlineSource = {
  kind: 'artifact-review',
  reviewId: REVIEW,
  round: 1,
  expectedReviewRevision: 4,
};
// What the owner returns for a request it has bound: the committed review, and optionally the request-time context.
const requestView = (
  source: unknown,
  candidates: unknown[],
  evidence: { progressReview?: string | null; taskContext?: unknown } = {},
) => {
  const progressReview = evidence.progressReview === undefined ? REVIEW : evidence.progressReview;
  return new Response(
    JSON.stringify({
      stage: 'queued',
      candidates,
      acceptances: [],
      record: {
        requestId: REQUEST_ID,
        payload: { source, ...(evidence.taskContext ? { taskContext: evidence.taskContext } : {}) },
        progress: progressReview ? { review: { reviewId: progressReview, round: 1, receiptRef: 'bound' } } : {},
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

let root: Root;
let host: HTMLElement;
let pending: ModificationFocus | null = null;
const openPublication = vi.fn();
const openWorkspacePath = vi.fn(() => true);
const Probe = () => {
  pending = usePendingModificationFocus();
  return null;
};
const render = async (state: ContentModificationReceiptV1['state'] = 'candidate') => {
  await act(async () => {
    root.render(
      <>
        <Probe />
        <ContentModificationReceiptCard receipt={receipt(state)} messageId="host-receipt-1" getCatById={getCatById} />
      </>,
    );
  });
};
const click = (name: string) =>
  act(async () => (host.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement).click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.fetch.mockReset();
  openPublication.mockReset();
  // The store mints the next navigation revision and returns true while the conversation is still the current one.
  openPublication.mockImplementation(() => {
    useChatStore.setState({ workspaceOpenRevision: useChatStore.getState().workspaceOpenRevision + 1 });
    return true;
  });
  openWorkspacePath.mockClear();
  useChatStore.setState({
    currentThreadId: 'thread-1',
    workspaceOpenRevision: 6,
    openPublication,
    openWorkspacePath,
  } as never);
  clearModificationFocus();
  pending = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  clearModificationFocus();
  await act(async () => root.unmount());
  host.remove();
});

describe('a receipt for a request made on a published work or a Task round', () => {
  it.each([
    ['a publication', publicationSource],
    ['a Task round', inlineSource],
  ])('opens the work the returned version belongs to, from %s, and remembers the message to come back to', async (_name, source) => {
    mocks.fetch.mockImplementation(async () =>
      requestView(source, [mediaCandidate('candidate-other', OTHER, 9), mediaCandidate(CANDIDATE_REF, COVER, 2)]),
    );
    await render('candidate');
    await click('打开对照');
    expect(String(mocks.fetch.mock.calls[0][0])).toBe(`/api/content-modifications/${REQUEST_ID}`);
    // The returned version's own coordinates, not the original's: the owner resolves that to the round that holds it.
    expect(openPublication).toHaveBeenCalledTimes(1);
    expect(openPublication).toHaveBeenCalledWith(
      {
        kind: 'publication',
        contentRef: COVER,
        ownerRevision: 2,
        // The review the request is committed to travels with the version: the owner enters it there or not at all.
        reviewId: REVIEW,
        title: '作品',
        navigationOrigin: { kind: 'chat-file-link', threadId: 'thread-1', messageId: 'host-receipt-1' },
      },
      'thread-1',
    );
    expect(openWorkspacePath).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('leaves an ask for exactly the version it opened, tied to that very navigation', async () => {
    mocks.fetch.mockImplementation(async () =>
      requestView(publicationSource, [mediaCandidate(CANDIDATE_REF, COVER, 2)]),
    );
    await render('candidate');
    await click('打开对照');
    expect(pending?.candidateRef).toBe(CANDIDATE_REF);
    expect(pending?.asset).toEqual({ contentRef: COVER, ownerRevision: 2 });
    // The revision the open request was given: openPublication minted 7 on top of 6.
    expect(pending?.navigation).toEqual({ threadId: 'thread-1', revision: 7 });
    expect(pending?.record.requestId).toBe(REQUEST_ID);
  });

  it('opens the comparison for the approve and request-changes verdicts as well', async () => {
    for (const state of ['approved', 'changes_requested'] as const) {
      openPublication.mockClear();
      mocks.fetch.mockImplementation(async () => requestView(inlineSource, [mediaCandidate(CANDIDATE_REF, COVER, 2)]));
      await render(state);
      await click('打开对照');
      expect(openPublication).toHaveBeenCalledTimes(1);
    }
  });

  it('does not guess a version when the receipt names one the request does not hold', async () => {
    mocks.fetch.mockImplementation(async () =>
      requestView(publicationSource, [mediaCandidate('candidate-other', OTHER, 9)]),
    );
    await render('candidate');
    await click('打开对照');
    expect(openPublication).not.toHaveBeenCalled();
    expect(pending).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('这份修改返回的版本暂时找不到，无法打开对照。');
  });

  it('says so instead of throwing when the returned version is one this shell cannot open', async () => {
    // The owner's coordinates are what the Workspace builds a surface from; a shape it cannot open must not reach it.
    mocks.fetch.mockImplementation(async () =>
      requestView(publicationSource, [mediaCandidate(CANDIDATE_REF, 'published-pair', 2)]),
    );
    await render('candidate');
    await click('打开对照');
    expect(openPublication).not.toHaveBeenCalled();
    expect(pending).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('这份修改返回的版本暂时找不到，无法打开对照。');
  });

  it('names the review from the committed binding when the request has no context (its Task and review were created at bind time)', async () => {
    mocks.fetch.mockImplementation(async () =>
      requestView(publicationSource, [mediaCandidate(CANDIDATE_REF, COVER, 2)], { progressReview: REVIEW }),
    );
    await render('candidate');
    await click('打开对照');
    expect(openPublication.mock.calls[0]?.[0]).toMatchObject({ contentRef: COVER, ownerRevision: 2, reviewId: REVIEW });
  });

  it('names the review from the request-time context when nothing is committed yet', async () => {
    const taskContext = {
      kind: 'media',
      taskId: 't',
      expectedTaskRevision: 1,
      reviewId: REVIEW,
      expectedReviewRevision: 3,
      round: 1,
    };
    mocks.fetch.mockImplementation(async () =>
      requestView(publicationSource, [mediaCandidate(CANDIDATE_REF, COVER, 2)], { progressReview: null, taskContext }),
    );
    await render('candidate');
    await click('打开对照');
    expect(openPublication.mock.calls[0]?.[0]).toMatchObject({ reviewId: REVIEW });
  });

  it('does not open the work generically when nothing names the review the request belongs to', async () => {
    mocks.fetch.mockImplementation(async () =>
      requestView(publicationSource, [mediaCandidate(CANDIDATE_REF, COVER, 2)], { progressReview: null }),
    );
    await render('candidate');
    await click('打开对照');
    expect(openPublication).not.toHaveBeenCalled();
    expect(pending).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(REVIEW_UNCONFIRMED);
  });

  it('does not choose between reviews when the request evidence names different ones', async () => {
    mocks.fetch.mockImplementation(async () =>
      requestView(inlineSource, [mediaCandidate(CANDIDATE_REF, COVER, 2)], { progressReview: SIBLING }),
    );
    await render('candidate');
    await click('打开对照');
    expect(openPublication).not.toHaveBeenCalled();
    expect(pending).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(REVIEW_UNCONFIRMED);
  });

  it('does not take the work when the conversation was switched while the request was read', async () => {
    mocks.fetch.mockImplementation(async () => {
      useChatStore.setState({ currentThreadId: 'thread-2' } as never);
      return requestView(publicationSource, [mediaCandidate(CANDIDATE_REF, COVER, 2)]);
    });
    openPublication.mockImplementation(() => false);
    await render('candidate');
    await click('打开对照');
    expect(pending).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('对话已切换。回到来源后可以继续打开。');
  });

  it('keeps saying so for an original that is neither a file nor a published work or round', async () => {
    mocks.fetch.mockImplementation(async () =>
      requestView({ kind: 'evolution', reviewId: 'review-x' }, [mediaCandidate(CANDIDATE_REF, COVER, 2)]),
    );
    await render('candidate');
    await click('打开对照');
    expect(openPublication).not.toHaveBeenCalled();
    expect(openWorkspacePath).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(NOT_A_FILE);
  });

  it('does not offer a file for a request that has none: only a comparison opens a returned version', async () => {
    mocks.fetch.mockImplementation(async () =>
      requestView(publicationSource, [mediaCandidate(CANDIDATE_REF, COVER, 2)]),
    );
    await render('applied');
    await click('打开文件');
    expect(openPublication).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(NOT_A_FILE);
  });
});
