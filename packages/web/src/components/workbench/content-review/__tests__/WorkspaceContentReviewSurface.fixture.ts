import type { WorkspaceContentReviewView } from '@cat-cafe/shared';

export const revision = `sha256:${'a'.repeat(64)}`;
export const reviewId = `workspace-review-${'b'.repeat(64)}`;

export function view(annotation = false): WorkspaceContentReviewView {
  return {
    review: {
      version: 1,
      reviewId,
      ownerUserId: 'operator',
      contentRef: `workspace-content:${'c'.repeat(64)}`,
      source: {
        kind: 'text',
        locator: { worktreeId: 'worktree-a', path: 'notes.md' },
        revision,
        mime: 'text/markdown',
        byteLength: 29,
      },
      revision: annotation ? 2 : 1,
      annotations: annotation
        ? [
            {
              id: `workspace-annotation-${'d'.repeat(64)}`,
              anchor: {
                kind: 'text_quote',
                baseRevision: revision,
                start: 9,
                end: 30,
                quote: 'A unique source quote.',
                quoteDigest: revision,
                contextDigest: revision,
              },
              body: 'Please clarify this sentence.',
              author: { kind: 'human', actorId: 'operator' },
              createdAt: '2026-09-16T00:00:00.000Z',
              updatedAt: '2026-09-16T00:00:00.000Z',
              state: 'open',
            },
          ]
        : [],
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    },
    sourceState: 'current',
    currentSource: {
      kind: 'text',
      locator: { worktreeId: 'worktree-a', path: 'notes.md' },
      revision,
      mime: 'text/markdown',
      byteLength: 29,
    },
    annotationResolutions: annotation
      ? [{ annotationId: `workspace-annotation-${'d'.repeat(64)}`, status: 'attached' }]
      : [],
    canWrite: true,
  };
}

export function mediaView(): WorkspaceContentReviewView {
  const source = {
    kind: 'media' as const,
    locator: { worktreeId: 'worktree-a', path: 'cover.png' },
    revision,
    mime: 'image/png' as const,
    byteLength: 12,
    media: { kind: 'image' as const, width: 160, height: 100 },
  };
  return {
    review: {
      version: 1,
      reviewId,
      ownerUserId: 'operator',
      contentRef: `workspace-content:${'c'.repeat(64)}`,
      source,
      revision: 1,
      annotations: [],
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    },
    sourceState: 'current',
    currentSource: source,
    annotationResolutions: [],
    canWrite: true,
  };
}

export function videoDiscussionView(): WorkspaceContentReviewView {
  const initial = mediaView();
  const source = {
    kind: 'media' as const,
    locator: { worktreeId: 'worktree-a', path: 'clip.mp4' },
    revision,
    mime: 'video/mp4' as const,
    byteLength: 12,
    media: {
      kind: 'video' as const,
      width: 160,
      height: 100,
      codedWidth: 160,
      codedHeight: 100,
      rotation: 0 as const,
      pixelAspectRatio: { numerator: 1, denominator: 1 },
      streamId: 'ordinary-video-stream',
      streamIndex: 0,
      timebase: { numerator: 1, denominator: 1000 },
      startTick: 0,
      durationTicks: 10_000,
      containerStartSeconds: 0,
    },
  };
  const annotations: WorkspaceContentReviewView['review']['annotations'] = [
    {
      id: 'ordinary-video-comment',
      anchor: {
        baseRevision: revision,
        anchor: {
          kind: 'video-range' as const,
          streamId: 'ordinary-video-stream',
          startTick: 2_500,
          endTick: 3_000,
          framePoint: { tick: 2_500, x: 64, y: 40 },
        },
      },
      body: 'Jump to the selected ordinary video frame.',
      author: { kind: 'human' as const, actorId: 'operator' },
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
      state: 'open' as const,
      replies: [],
    },
  ];
  return {
    ...initial,
    review: { ...initial.review, source, annotations },
    currentSource: source,
    annotationResolutions: [{ annotationId: 'ordinary-video-comment', status: 'attached' }],
  };
}

export function discussionView(): WorkspaceContentReviewView {
  const initial = mediaView();
  initial.review.revision = 2;
  initial.review.annotations = [
    {
      id: 'ordinary-action-comment',
      anchor: { baseRevision: revision, anchor: { kind: 'image-point', x: 32, y: 48 } },
      body: 'Please review this ordinary file.',
      author: { kind: 'human', actorId: 'operator' },
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
      state: 'open',
      replies: [],
    },
  ];
  Object.assign(initial, { annotationResolutions: [{ annotationId: 'ordinary-action-comment', status: 'attached' }] });
  return initial;
}

export function replyView(
  initial: WorkspaceContentReviewView,
  replyId: string,
  body: string,
): WorkspaceContentReviewView {
  const next = structuredClone(initial);
  next.review.revision = initial.review.revision + 1;
  next.review.annotations = next.review.annotations.map((annotation) => ({
    ...annotation,
    replies: [
      {
        id: replyId,
        body,
        author: { kind: 'human', actorId: 'operator' },
        createdAt: '2026-09-18T00:01:00.000Z',
        updatedAt: '2026-09-18T00:01:00.000Z',
      },
    ],
  }));
  return next;
}
