import type { VideoProjectReviewHistory } from '@cat-cafe/shared';
import { workspaceContentReviewSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { projectPath, projectRequest } from '../api';

/** Synchronization may fail independently of a readable retained ledger. */
export async function synchronizeProjectReview(contentRef: string, threadId: string | null, signal: AbortSignal) {
  if (!threadId) return { pending: null, error: null };
  try {
    const result = z
      .object({ imported: z.number(), scanned: z.number(), hasMore: z.boolean() })
      .passthrough()
      .parse(
        await projectRequest(`${projectPath(contentRef)}/review/synchronize`, {
          signal,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId }),
        }),
      );
    return { pending: result.hasMore, error: null };
  } catch (error) {
    return { pending: true, error };
  }
}
export async function readProjectReview(contentRef: string, signal: AbortSignal) {
  const result = z
    .object({ review: workspaceContentReviewSchema })
    .passthrough()
    .parse(await projectRequest(`${projectPath(contentRef)}/review`, { signal }));
  if (result.review.contentRef !== contentRef) throw new Error('意见项目引用不匹配。');
  return result.review;
}

export function isUnchanged(event: VideoProjectReviewHistory | undefined) {
  return event?.kind === 'addressed' && event.result && 'kind' in event.result && event.result.kind === 'not-changed';
}

export async function reopenProjectOpinion(
  contentRef: string,
  expectedRevision: number,
  annotationId: string,
  reason: string,
  operationId: string,
) {
  try {
    await projectRequest(`${projectPath(contentRef)}/review/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision,
        operationId,
        action: { kind: 'reopened', annotationId, reason },
      }),
    });
  } catch (original) {
    const confirmed = await projectRequest(
      `${projectPath(contentRef)}/review/operations/${encodeURIComponent(operationId)}`,
    );
    if (!confirmed || typeof confirmed !== 'object' || !('receipt' in confirmed) || !confirmed.receipt) throw original;
  }
}
