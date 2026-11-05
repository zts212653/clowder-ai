import type { ArtifactReviewRound, ArtifactReviewView, ContentModificationRecord } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSurfaceVisibilityProvider } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { useChatStore } from '@/stores/chatStore';
import { ArtifactReviewSurface } from '../ArtifactReviewSurface';
import { clearModificationFocus, focusModification, usePendingModificationFocus } from '../modification-focus';

// A receipt in the conversation asked to see the version a cat returned for a published work or a Task round. That
// version is a round of the review; the round surface recognises its own round by the version's identity and goes
// straight to the comparison, for as long as the navigation that asked is the newest one.
const mocks = vi.hoisted(() => ({ controller: vi.fn() }));
vi.mock('../useArtifactReview', () => ({
  useArtifactReview: (reviewId: string) => mocks.controller(reviewId),
  reviewDraftPrefix: (user: string, id: string) => `cat-cafe:review:${user}:${id}:`,
}));
vi.mock('../useReviewMediaSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../useReviewMediaSource')>()),
  useReviewMediaSource: () => ({ src: 'blob:original-owner-media', error: null }),
}));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: vi.fn() }));
vi.mock('../ReviewActor', () => ({ ReviewActor: () => <span>原作者</span> }));
vi.mock('../media-compare/ArtifactMediaCompare', () => ({
  ArtifactMediaCompare: ({ onClose, onBack }: { onClose: () => void; onBack: () => void }) => (
    <section data-testid="artifact-media-compare">
      <button type="button" aria-label="返回作品" onClick={onClose} />
      <button type="button" aria-label="返回来源" onClick={onBack} />
    </section>
  ),
}));

const stamp = '2026-10-04T04:00:00Z';
const REVIEW_ID = `review-${'a'.repeat(64)}`;
const WORK = 'content-cover';
const THREAD = 'thread-1';
const round = (number: number): ArtifactReviewRound =>
  ({
    number,
    openedAt: stamp,
    state: number === 1 ? 'approved' : 'awaiting_human',
    responses: [],
    annotations: [],
    asset: {
      contentRef: WORK,
      ownerRevision: number,
      blobDigest: `sha256:${String(number).repeat(64)}`,
      mediaType: 'image/png',
      media: { kind: 'image', width: 390, height: 844 },
      ownerReceiptRef: `owner:${number}`,
      sourcePublication: { artifactRef: `/uploads/${number}.png`, sourceRef: 'message:one', revision: String(number) },
    },
  }) as ArtifactReviewRound;
const reviewView = (rounds: ArtifactReviewRound[]): ArtifactReviewView =>
  ({
    review: {
      version: 3,
      reviewId: REVIEW_ID,
      revision: 3,
      title: '秋日封面',
      contentRef: WORK,
      task: { taskId: 'task-one', threadId: 'thread-one', ownerUserId: 'operator', observedRevision: 1 },
      createdAt: stamp,
      updatedAt: stamp,
      rounds,
    },
    authority: { state: 'current', canWrite: true, taskRevision: 1, ownerCatId: 'codex-sol' },
    pendingVersion: false,
    continuation: {
      taskId: 'task-one',
      expectedRevision: 1,
      artifactRef: 'content:old',
      reviewEvidenceRef: 'review:original',
      ownerCatId: 'codex-sol',
    },
  }) as ArtifactReviewView;

const record = (reviewId: string = REVIEW_ID) =>
  ({
    requestId: `f309-modification-${'d'.repeat(64)}`,
    ownerUserId: 'operator',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    progress: {},
    payload: {
      source: { kind: 'artifact-review', reviewId, round: 1, expectedReviewRevision: 3 },
      taskContext: {
        kind: 'media',
        taskId: 'task-one',
        expectedTaskRevision: 1,
        reviewId,
        expectedReviewRevision: 3,
        round: 1,
      },
    },
  }) as unknown as ContentModificationRecord;

let root: Root;
let container: HTMLDivElement;
let pending: ReturnType<typeof usePendingModificationFocus> = null;
const Probe = () => {
  pending = usePendingModificationFocus();
  return null;
};
const ask = (patch: Partial<Parameters<typeof focusModification>[0]> = {}) =>
  act(async () =>
    focusModification({
      record: record(),
      candidateRef: 'candidate-round-2',
      asset: { contentRef: WORK, ownerRevision: 2 },
      navigation: { threadId: THREAD, revision: 7 },
      ...patch,
    }),
  );
const navigate = (revision: number, threadId = THREAD) =>
  act(async () => useChatStore.setState({ workspaceOpenRevision: revision, currentThreadId: threadId } as never));
const mount = async (rounds: ArtifactReviewRound[] = [round(1), round(2)], initialRound = 2, visible = true) => {
  mocks.controller.mockReturnValue({
    view: reviewView(rounds),
    error: null,
    pending: null,
    saving: false,
    loading: false,
    act: vi.fn(),
    retry: vi.fn(),
    refresh: vi.fn(),
    revokeAccess: vi.fn(),
  });
  await act(async () =>
    root.render(
      <>
        <Probe />
        <WorkspaceSurfaceVisibilityProvider visible={visible}>
          <ArtifactReviewSurface reviewId={REVIEW_ID} onBack={vi.fn()} initialRound={initialRound} />
        </WorkspaceSurfaceVisibilityProvider>
      </>,
    ),
  );
};
const comparing = () => container.querySelector('[data-testid="artifact-media-compare"]') !== null;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  clearModificationFocus();
  pending = null;
  useChatStore.setState({ currentThreadId: THREAD, workspaceOpenRevision: 7, workspaceOpenRequest: null } as never);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  clearModificationFocus();
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** A request as the owner committed it: the binding, the request-time context and the source each may name a review. */
const requestWith = (parts: {
  progressReview?: string;
  taskContext?: ContentModificationRecord['payload']['taskContext'] | null;
  source?: unknown;
}) => {
  const base = record();
  const payload = { ...base.payload, source: parts.source ?? base.payload.source } as Record<string, unknown>;
  if (parts.taskContext === null) delete payload.taskContext;
  else if (parts.taskContext) payload.taskContext = parts.taskContext;
  return {
    ...base,
    progress: parts.progressReview ? { review: { reviewId: parts.progressReview, round: 1, receiptRef: 'bound' } } : {},
    payload,
  } as unknown as ContentModificationRecord;
};
const OTHER = `review-${'f'.repeat(64)}`;
const publicationSource = {
  kind: 'publication',
  contentRef: WORK,
  ownerRevision: 1,
  ledgerRef: 'ledger-a',
  expectedLedgerRevision: 1,
};

describe('the round surface takes a request only when the owner committed it to this review', () => {
  it('takes a request with no context whose committed binding names this review', async () => {
    await mount();
    await ask({
      record: requestWith({ progressReview: REVIEW_ID, taskContext: null, source: publicationSource }),
    });
    expect(comparing()).toBe(true);
    expect(pending).toBeNull();
  });

  it('does not take a request committed to a sibling review that holds the same version', async () => {
    await mount();
    await ask({ record: requestWith({ progressReview: OTHER, taskContext: null, source: publicationSource }) });
    expect(comparing()).toBe(false);
    expect(pending).not.toBeNull();
  });

  it('does not take a Task-round request whose source names another review when there is no context', async () => {
    await mount();
    await ask({
      record: requestWith({
        taskContext: null,
        source: { kind: 'artifact-review', reviewId: OTHER, round: 1, expectedReviewRevision: 3 },
      }),
    });
    expect(comparing()).toBe(false);
    expect(pending).not.toBeNull();
  });

  it('does not decide on the asset alone when nothing names a review', async () => {
    await mount();
    await ask({ record: requestWith({ taskContext: null, source: publicationSource }) });
    expect(comparing()).toBe(false);
    expect(pending).not.toBeNull();
  });

  it('does not take a request whose own evidence names different reviews', async () => {
    await mount();
    await ask({
      record: requestWith({
        progressReview: REVIEW_ID,
        source: publicationSource,
        taskContext: {
          kind: 'media',
          taskId: 'task-one',
          expectedTaskRevision: 1,
          reviewId: OTHER,
          expectedReviewRevision: 3,
          round: 1,
        },
      }),
    });
    expect(comparing()).toBe(false);
    expect(pending).not.toBeNull();
  });
});

describe('the round surface and a receipt asking for the returned version', () => {
  it('shows the round and not the comparison when nothing asked for it', async () => {
    await mount();
    expect(container.querySelector('[data-testid="artifact-review-surface"]')).not.toBeNull();
    expect(comparing()).toBe(false);
  });

  it('goes straight to the comparison when the ask names the version this round holds', async () => {
    await mount();
    await ask();
    expect(comparing()).toBe(true);
    // The ask is taken once: it is not left behind for another surface to act on a second time.
    expect(pending).toBeNull();
    // The round surface stays mounted underneath, only out of the way (its marks and draft are not torn down).
    expect(container.querySelector('[data-testid="workspace-content-review-surface"]')).not.toBeNull();
  });

  it('takes an ask that was left before the round surface mounted', async () => {
    await ask();
    await mount();
    expect(comparing()).toBe(true);
    expect(pending).toBeNull();
  });

  it('waits for the new Workspace navigation instead of letting the previously mounted round consume its ask', async () => {
    await mount();
    await act(async () =>
      useChatStore.setState({
        workspaceOpenRevision: 8,
        workspaceOpenRequest: {
          revision: 8,
          threadId: THREAD,
          target: { kind: 'publication', contentRef: WORK, ownerRevision: 2, reviewId: REVIEW_ID, title: '作品' },
          disposition: 'preview',
        },
      }),
    );
    await ask({ navigation: { threadId: THREAD, revision: 8 } });
    expect(comparing()).toBe(false);
    expect(pending?.candidateRef).toBe('candidate-round-2');
    // The resolver replaces the old owner and only then the newly mounted round can take the accepted click.
    await act(async () => root.render(<Probe />));
    await act(async () => useChatStore.getState().consumeWorkspaceOpenRequest(8));
    await mount();
    expect(comparing()).toBe(true);
    expect(pending).toBeNull();
  });

  it('leaves the accepted comparison ask for the visible round instead of a hidden retained round', async () => {
    await mount(undefined, 2, false);
    await ask();
    expect(comparing()).toBe(false);
    expect(pending?.candidateRef).toBe('candidate-round-2');
    await mount(undefined, 2, true);
    expect(comparing()).toBe(true);
    expect(pending).toBeNull();
  });

  it('waits for its own round: another version of the work is not a reason to compare this one', async () => {
    await mount();
    await ask({ asset: { contentRef: WORK, ownerRevision: 3 } });
    expect(comparing()).toBe(false);
    expect(pending?.candidateRef).toBe('candidate-round-2');
    await ask({ asset: { contentRef: 'another-work', ownerRevision: 2 } });
    expect(comparing()).toBe(false);
  });

  it('does not take a request that belongs to another review', async () => {
    await mount();
    await ask({ record: record(`review-${'f'.repeat(64)}`) });
    expect(comparing()).toBe(false);
    expect(pending).not.toBeNull();
  });

  it('does not take an ask from a navigation that is no longer the newest, or from another conversation', async () => {
    await mount();
    await navigate(8);
    await ask({ navigation: { threadId: THREAD, revision: 7 } });
    expect(comparing()).toBe(false);
    await ask({ navigation: { threadId: 'thread-2', revision: 8 } });
    expect(comparing()).toBe(false);
  });

  it('has nothing to compare against for the first round', async () => {
    await mount([round(1)], 1);
    await ask({ asset: { contentRef: WORK, ownerRevision: 1 } });
    expect(comparing()).toBe(false);
  });

  it('ends when a newer navigation reaches the Workspace: opening the work again shows the round', async () => {
    await mount();
    await ask();
    expect(comparing()).toBe(true);
    await navigate(8);
    expect(comparing()).toBe(false);
    expect(container.querySelector('[data-testid="artifact-review-surface"]')).not.toBeNull();
  });

  it('gives the round back on request, and does not take the same ask a second time', async () => {
    await mount();
    await ask();
    await act(async () => (container.querySelector('button[aria-label="返回作品"]') as HTMLButtonElement).click());
    expect(comparing()).toBe(false);
    expect(pending).toBeNull();
  });

  it("puts the round's own panel aside while the comparison is open, as the person's own button does", async () => {
    await mount();
    await act(async () => (container.querySelector('button[aria-label="完成审阅"]') as HTMLButtonElement).click());
    expect(container.querySelector('aside[aria-label="审阅结论"]')).not.toBeNull();
    await ask();
    expect(comparing()).toBe(true);
    await act(async () => (container.querySelector('button[aria-label="返回作品"]') as HTMLButtonElement).click());
    expect(container.querySelector('aside[aria-label="审阅结论"]')).toBeNull();
  });

  it('enters again for a new ask from a newer navigation', async () => {
    await mount();
    await ask();
    await act(async () => (container.querySelector('button[aria-label="返回作品"]') as HTMLButtonElement).click());
    await navigate(9);
    await ask({ navigation: { threadId: THREAD, revision: 9 } });
    expect(comparing()).toBe(true);
  });

  it("keeps the person's own choice to compare when a newer navigation arrives", async () => {
    await mount();
    await act(async () => (container.querySelector('button[aria-label="对比版本"]') as HTMLButtonElement).click());
    expect(comparing()).toBe(true);
    await navigate(8);
    expect(comparing()).toBe(true);
  });
});
