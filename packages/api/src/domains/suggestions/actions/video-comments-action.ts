import type { ImmutableMedia } from '@cat-cafe/shared';
import { z } from 'zod';
import {
  type PublicationReviewPort,
  resolvePublicationReviewSource,
} from '../../collaborative-content/workspace-review/publication-review-source.js';
import type { WorkspaceContentReviewService } from '../../collaborative-content/workspace-review/service.js';
import { workspaceAnnotationId } from '../../collaborative-content/workspace-review/workspace-review-anchors.js';
import type {
  SuggestionActionContext,
  SuggestionActionHandler,
  SuggestionActionResult,
  SuggestionApplied,
} from '../suggestion-actions.js';

export const VIDEO_COMMENTS_SUGGESTION_KIND = 'video-comments';

const paramsSchema = z
  .object({
    /** The Works video and the exact version the comments are timed against. */
    contentRef: z.string().trim().min(1).max(500),
    ownerRevision: z.number().int().positive(),
    title: z.string().trim().min(1).max(200),
    comments: z
      .array(
        z
          .object({
            /** Player time, as the person sees it in the video. */
            atSeconds: z.number().finite().nonnegative(),
            endSeconds: z.number().finite().nonnegative().optional(),
            text: z.string().trim().min(1).max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
type VideoCommentsParams = z.infer<typeof paramsSchema>;
type Video = Extract<ImmutableMedia, { kind: 'video' }>;

export interface VideoCommentsSuggestionDeps {
  /** The Works publication review owner (the same one the Works video page writes through). */
  reviews?: Pick<WorkspaceContentReviewService, 'prepare' | 'read' | 'annotate' | 'act' | 'resolvePublication'>;
  publications?: PublicationReviewPort;
  /** Let an open Works page refresh (same event the publication review routes send). */
  changed?(userId: string, reviewId: string): void;
}

const fail = <T>(error: string): SuggestionActionResult<T> => ({ ok: false, error });

function principalOf(ctx: SuggestionActionContext) {
  return { userId: ctx.userId, actor: { kind: 'human' as const, actorId: ctx.userId } };
}

/** Same clock as the Works player (`browserTimeToTick`): player seconds already include the container offset. */
function toTick(seconds: number, media: Video): number {
  return Math.round((seconds * media.timebase.denominator) / media.timebase.numerator);
}

function anchorFor(comment: VideoCommentsParams['comments'][number], media: Video) {
  const first = media.startTick;
  const last = media.startTick + media.durationTicks;
  const start = Math.min(Math.max(toTick(comment.atSeconds, media), first), last - 1);
  const requestedEnd = comment.endSeconds === undefined ? start + 1 : toTick(comment.endSeconds, media);
  const end = Math.min(Math.max(requestedEnd, start + 1), last);
  return { kind: 'video-range' as const, streamId: media.streamId, startTick: start, endTick: end };
}

function refOf(ref: Record<string, unknown>): { reviewId: string; annotationIds: string[] } | null {
  const { reviewId, annotationIds } = ref;
  if (typeof reviewId !== 'string' || !Array.isArray(annotationIds)) return null;
  const ids = annotationIds.filter((id): id is string => typeof id === 'string');
  return ids.length === annotationIds.length ? { reviewId, annotationIds: ids } : null;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Reviews = NonNullable<VideoCommentsSuggestionDeps['reviews']>;

/** Take back the listed annotations that are still there, in order; reports how far it got. */
async function withdrawAll(
  reviews: Reviews,
  principal: ReturnType<typeof principalOf>,
  reviewId: string,
  annotationIds: readonly string[],
): Promise<{ withdrawn: string[]; error?: string }> {
  const withdrawn: string[] = [];
  try {
    const view = await reviews.read({ principal, reviewId });
    let revision = view.review.revision;
    for (const annotation of view.review.annotations.filter((item) => annotationIds.includes(item.id))) {
      const result = await reviews.act({
        principal,
        reviewId,
        expectedRevision: revision,
        operationId: `sugg-withdraw-${annotation.id}`,
        action: { kind: 'withdraw_annotation', annotationId: annotation.id },
      });
      revision = result.replayed
        ? (await reviews.read({ principal, reviewId })).review.revision
        : result.review.revision;
      withdrawn.push(annotation.id);
    }
    return { withdrawn };
  } catch (error) {
    return { withdrawn, error: describe(error) };
  }
}

/**
 * A batch stopped part-way: take back what this attempt wrote; if that fails too, return the annotations that stayed
 * so the row can say so and stay undoable.
 */
async function takeBackFailedBatch(
  reviews: Reviews,
  principal: ReturnType<typeof principalOf>,
  reviewId: string | null,
  written: string[],
  cause: unknown,
): Promise<{ error: string; partial?: string[] }> {
  if (!reviewId || written.length === 0) return { error: `批注没加上：${describe(cause)}` };
  const back = await withdrawAll(reviews, principal, reviewId, written);
  if (!back.error)
    return { error: `第 ${written.length + 1} 条没加上，已加的 ${written.length} 条已撤回：${describe(cause)}` };
  const kept = written.filter((id) => !back.withdrawn.includes(id));
  return { error: `只加上了 ${kept.length} 条，其余没加上，也没能撤回：${describe(cause)}`, partial: kept };
}

/**
 * Write the batch in order, as the person. Stops at the first failure and reports how far it got, so the caller can
 * take that part back. Operation ids are keyed by suggestion + attempt: a retried attempt replays, never doubles.
 */
async function writeComments(
  reviews: Reviews,
  principal: ReturnType<typeof principalOf>,
  ctx: SuggestionActionContext,
  comments: VideoCommentsParams['comments'],
  video: Video,
  target: { contentRef: string; ownerRevision: number },
): Promise<{ closed: true } | { reviewId: string | null; written: string[]; error?: unknown }> {
  const written: string[] = [];
  let reviewId: string | null = null;
  try {
    const opened = await reviews.prepare({
      principal,
      publication: { contentRef: target.contentRef, ownerRevision: target.ownerRevision },
      operationId: `sugg-${ctx.suggestionId}-prepare`,
    });
    if (!opened.canWrite) return { closed: true };
    reviewId = opened.review.reviewId;
    let revision = opened.review.revision;
    for (const [index, comment] of comments.entries()) {
      const operationId = `sugg-${ctx.suggestionId}-a${ctx.attempt ?? 1}-${index}`;
      const result = await reviews.annotate({
        principal,
        reviewId,
        expectedRevision: revision,
        operationId,
        body: comment.text,
        target: { kind: 'media_anchor', anchor: anchorFor(comment, video) },
      });
      // A retried attempt replays its earlier receipt; read the review again to continue from where it is now.
      revision = result.replayed
        ? (await reviews.read({ principal, reviewId })).review.revision
        : result.review.revision;
      written.push(workspaceAnnotationId(reviewId, operationId));
    }
    return { reviewId, written };
  } catch (error) {
    return { reviewId, written, error };
  }
}

/**
 * 「添加视频批注」：猫对好时间点、写好每条，人点一下，用人自己的身份写进作品的意见（和人在作品页里批注是同一处）。
 * 撤销：作者撤回自己还没人回复的批注。「改了」：提议加的批注少了。
 */
export function createVideoCommentsSuggestionAction(deps: VideoCommentsSuggestionDeps): SuggestionActionHandler {
  async function videoOf(
    ctx: SuggestionActionContext,
    params: VideoCommentsParams,
  ): Promise<SuggestionActionResult<Video>> {
    if (!deps.reviews || !deps.publications) return fail('Works comments are not available here');
    const target = { contentRef: params.contentRef, ownerRevision: params.ownerRevision };
    try {
      const contexts = await deps.reviews.resolvePublication(target, principalOf(ctx));
      if (contexts.some((context) => !context.ledgerRef)) {
        return fail('This work is discussed in a task review; comment there with cat_cafe_act_artifact_review');
      }
      const { source } = await resolvePublicationReviewSource(deps.publications, target, principalOf(ctx));
      if (source.media.kind !== 'video') return fail('This work is not a video');
      return { ok: true, value: source.media };
    } catch (error) {
      return fail(`Cannot read that work: ${describe(error)}`);
    }
  }

  return {
    kind: VIDEO_COMMENTS_SUGGESTION_KIND,
    kindLabel: '添加视频批注',
    undoLabel: 'undo',

    async prepare(ctx, raw) {
      const parsed = paramsSchema.safeParse(raw);
      if (!parsed.success) return fail(`Invalid video comments: ${parsed.error.issues[0]?.message ?? 'bad params'}`);
      const video = await videoOf(ctx, parsed.data);
      if (!video.ok) return video;
      const lastSecond =
        ((video.value.startTick + video.value.durationTicks) * video.value.timebase.numerator) /
        video.value.timebase.denominator;
      if (parsed.data.comments.some((comment) => comment.atSeconds > lastSecond)) {
        return fail(`A comment is past the end of the video (${lastSecond.toFixed(1)}s)`);
      }
      return { ok: true, value: parsed.data };
    },

    async apply(ctx, raw) {
      const parsed = paramsSchema.safeParse(raw);
      if (!parsed.success || !deps.reviews) return fail('Invalid video comments');
      const video = await videoOf(ctx, parsed.data);
      if (!video.ok) return video;
      const params = parsed.data;
      const principal = principalOf(ctx);
      const batch = await writeComments(deps.reviews, principal, ctx, params.comments, video.value, params);
      if ('closed' in batch) return fail('这一版作品已经不能再加批注了');
      const applied = (reviewId: string, ids: string[], text: string): SuggestionApplied => ({
        appliedRef: {
          reviewId,
          annotationIds: ids,
          contentRef: params.contentRef,
          ownerRevision: params.ownerRevision,
        },
        receipt: {
          text,
          open: {
            kind: 'work',
            contentRef: params.contentRef,
            ownerRevision: params.ownerRevision,
            title: params.title,
          },
        },
      });
      if (batch.error !== undefined || !batch.reviewId) {
        const settled = await takeBackFailedBatch(deps.reviews, principal, batch.reviewId, batch.written, batch.error);
        if (!settled.partial || !batch.reviewId) return fail(settled.error);
        deps.changed?.(ctx.userId, batch.reviewId);
        const kept = settled.partial;
        return {
          ok: false,
          error: settled.error,
          partial: applied(batch.reviewId, kept, `已添加 ${kept.length} 条批注（其余没加上）`),
        };
      }
      deps.changed?.(ctx.userId, batch.reviewId);
      return { ok: true, value: applied(batch.reviewId, batch.written, `已添加 ${batch.written.length} 条批注`) };
    },

    async undo(ctx, raw) {
      const ref = refOf(raw);
      if (!ref || !deps.reviews) return fail('没有可撤销的批注');
      const principal = principalOf(ctx);
      try {
        const view = await deps.reviews.read({ principal, reviewId: ref.reviewId });
        const present = view.review.annotations.filter((annotation) => ref.annotationIds.includes(annotation.id));
        if (present.some((annotation) => (annotation.replies?.length ?? 0) > 0)) {
          return fail('已经有人回复了这些批注，请到作品里标为已解决');
        }
      } catch (error) {
        return fail(`读不到这件作品的批注：${describe(error)}`);
      }
      const back = await withdrawAll(deps.reviews, principal, ref.reviewId, ref.annotationIds);
      deps.changed?.(ctx.userId, ref.reviewId);
      if (back.error) {
        // The row stays undoable; the next undo skips what is already gone and takes back the rest.
        return fail(`撤回了 ${back.withdrawn.length} 条，剩下的没撤回，再点一次撤销会接着撤：${back.error}`);
      }
      return { ok: true, value: undefined };
    },

    async inspect(ctx, raw) {
      const ref = refOf(raw);
      if (!ref || !deps.reviews) return 'unknown';
      const view = await deps.reviews.read({ principal: principalOf(ctx), reviewId: ref.reviewId });
      const present = view.review.annotations.filter((annotation) => ref.annotationIds.includes(annotation.id)).length;
      if (present === 0) return 'gone';
      return present < ref.annotationIds.length ? 'edited' : 'intact';
    },
  };
}
