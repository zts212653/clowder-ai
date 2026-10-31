import { afterEach, describe, it } from 'node:test';
import * as testFixture from './workspace-content-review-service.fixture.js';

const { WorkspaceContentReviewError, applyWorkspaceReviewAction, writeFile, principal, fixture, assert, join, sharp } =
  testFixture;
afterEach(testFixture.cleanupFixtureRoots);

describe('WorkspaceContentReviewService', () => {
  it('persists ordinary media marks and a discussion thread without borrowing a Task review, then retires both on source change', async () => {
    const { root, reviews, store } = await fixture();
    try {
      await writeFile(
        join(root, 'cover.png'),
        await sharp({ create: { width: 160, height: 100, channels: 3, background: '#eee4d5' } })
          .png()
          .toBuffer(),
      );
      const opened = await reviews.prepare({
        principal,
        locator: { worktreeId: 'worktree-a', path: 'cover.png' },
        operationId: 'open-media-discussion',
      });
      const annotation = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: opened.review.revision,
        operationId: 'comment-media-discussion',
        body: 'Please look at this corner.',
        target: { kind: 'media_anchor', anchor: { kind: 'image-point', x: 32, y: 48 } },
      });
      const annotationId = annotation.review.annotations[0]?.id;
      if (!annotationId) throw new Error('fixture must create a media annotation');

      const marked = await reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: annotation.review.revision,
        operationId: 'draw-media-discussion',
        action: {
          kind: 'add_visual_marks',
          marks: [
            {
              id: 'ordinary-rectangle',
              kind: 'rectangle',
              x: 16,
              y: 24,
              width: 48,
              height: 30,
              color: '#d04a3a',
              strokeWidth: 4,
            },
          ],
        },
      });
      const replayedMark = await reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: annotation.review.revision,
        operationId: 'draw-media-discussion',
        action: {
          kind: 'add_visual_marks',
          marks: [
            {
              id: 'ordinary-rectangle',
              kind: 'rectangle',
              x: 16,
              y: 24,
              width: 48,
              height: 30,
              color: '#d04a3a',
              strokeWidth: 4,
            },
          ],
        },
      });
      assert.equal(
        replayedMark.replayed,
        true,
        'an unknown visual-mark response must reuse its original operation receipt',
      );
      const replied = await reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: marked.review.revision,
        operationId: 'reply-media-discussion',
        action: {
          kind: 'reply',
          annotationId,
          replyId: 'ordinary-reply',
          body: 'I will keep this discussion attached to the file.',
        },
      });
      const resolved = await reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: replied.review.revision,
        operationId: 'resolve-media-discussion',
        action: { kind: 'set_annotation_state', annotationId, state: 'resolved' },
      });

      assert.equal(resolved.review.task, undefined, 'ordinary media must remain outside Task-bound artifact review');
      assert.equal(resolved.review.visualMarks?.[0]?.baseRevision, opened.review.source.revision);
      assert.equal(
        resolved.review.annotations[0]?.replies?.[0]?.body,
        'I will keep this discussion attached to the file.',
      );
      assert.equal(resolved.review.annotations[0]?.state, 'resolved');

      const rejectsInvalidAction = (callback: () => unknown) =>
        assert.throws(
          callback,
          (error) => error instanceof WorkspaceContentReviewError && error.code === 'invalid_action',
        );
      rejectsInvalidAction(() =>
        applyWorkspaceReviewAction({
          review: resolved.review,
          source: resolved.review.source,
          actor: { kind: 'human', actorId: 'not-the-mark-author' },
          action: { kind: 'delete_visual_mark', markId: 'ordinary-rectangle' },
          now: '2026-09-16T00:00:01.000Z',
        }),
      );
      rejectsInvalidAction(() =>
        applyWorkspaceReviewAction({
          review: resolved.review,
          source: resolved.review.source,
          actor: principal.actor,
          action: { kind: 'set_annotation_state', annotationId, state: 'resolved' },
          now: '2026-09-16T00:00:01.000Z',
        }),
      );
      const saturated = {
        ...resolved.review,
        annotations: resolved.review.annotations.map((item) => ({
          ...item,
          replies: Array.from({ length: 100 }, (_, index) => ({
            id: `reply-${index}`,
            body: `reply ${index}`,
            author: principal.actor,
            createdAt: '2026-09-16T00:00:00.000Z',
            updatedAt: '2026-09-16T00:00:00.000Z',
          })),
        })),
      };
      rejectsInvalidAction(() =>
        applyWorkspaceReviewAction({
          review: saturated,
          source: saturated.source,
          actor: principal.actor,
          action: {
            kind: 'reply',
            annotationId,
            replyId: 'reply-after-limit',
            body: 'This must explain the bounded discussion limit.',
          },
          now: '2026-09-16T00:00:01.000Z',
        }),
      );

      await writeFile(
        join(root, 'cover.png'),
        await sharp({ create: { width: 320, height: 200, channels: 3, background: '#a0563d' } })
          .png()
          .toBuffer(),
      );
      const changed = await reviews.read({ principal, reviewId: opened.review.reviewId });
      assert.equal(changed.sourceState, 'changed');
      assert.equal(changed.visualMarkResolutions[0]?.status, 'orphaned');
      await assert.rejects(
        reviews.act({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: resolved.review.revision,
          operationId: 'late-reply-after-owner-change',
          action: {
            kind: 'reply',
            annotationId,
            replyId: 'late-reply',
            body: 'This must not write against changed source.',
          },
        }),
        /source_changed/,
      );
    } finally {
      store.close();
    }
  });
});
