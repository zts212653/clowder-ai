import { collectiveArtifactReviewActionInputSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { type ClientRequest, CollectiveClientRequestError } from './client-request.js';
import type { CollectiveRecipient } from './client-types.js';
import type { SharedArtifact, SharedArtifactOperation, SharedMarkdownView } from './collective-artifact-client.js';
import type { SharedArtifactDraftReply } from './shared-artifact-draft.js';

const receiptResult = z.object({
  annotationId: z.string(),
  ownerRevision: z.number().int().positive(),
  receipt: z.object({
    reviewId: z.string(),
    receiptRef: z.string(),
    revision: z.number().int().positive(),
    actor: z.object({ kind: z.literal('human'), actorId: z.string() }),
  }),
});
function verifyReceipt(result: unknown, view: SharedMarkdownView, annotationId: string, humanId: string) {
  const parsed = receiptResult.parse(result);
  if (
    parsed.annotationId !== annotationId ||
    parsed.ownerRevision !== view.ownerRevision ||
    parsed.receipt.reviewId !== view.view.review.reviewId ||
    parsed.receipt.actor.actorId !== humanId
  )
    throw new Error('批注回执尚未核对，请重试原操作。');
  return parsed;
}

export async function setSharedAnnotationState(
  operation: SharedArtifactOperation,
  namespace: string,
  input: {
    artifact: SharedArtifact;
    view: SharedMarkdownView;
    annotationId: string;
    state: 'open' | 'resolved';
    humanId: string;
  },
) {
  const { artifact, view, annotationId, state, humanId } = input;
  if (!view.view.canWrite) throw new Error('请在当前版本处理批注。');
  const key = `collective-annotation-state:${namespace}:${artifact.artifactId}:${view.ownerRevision}:${annotationId}:${state}`;
  const saved = localStorage.getItem(key);
  const pending = z
    .object({ id: z.string().uuid(), input: collectiveArtifactReviewActionInputSchema })
    .strict()
    .parse(
      saved
        ? JSON.parse(saved)
        : {
            id: crypto.randomUUID(),
            input: {
              kind: 'review-action',
              expectedReviewRevision: view.view.review.revision,
              action: { kind: 'set_annotation_state', annotationId, state },
            },
          },
    );
  if (
    pending.input.action.kind !== 'set_annotation_state' ||
    pending.input.action.annotationId !== annotationId ||
    pending.input.action.state !== state
  )
    throw new Error('批注决定引用已改变，请重新读取。');
  const serialized = JSON.stringify(pending);
  localStorage.setItem(key, serialized);
  try {
    const result = verifyReceipt(
      await operation(artifact, 'annotate', pending.input, pending.id, view.ownerRevision),
      view,
      annotationId,
      humanId,
    );
    if (localStorage.getItem(key) === serialized) localStorage.removeItem(key);
    return result;
  } catch (error) {
    if (
      error instanceof CollectiveClientRequestError &&
      error.status === 409 &&
      localStorage.getItem(key) === serialized
    )
      localStorage.removeItem(key);
    throw error;
  }
}

export async function sendSharedAnnotationReply(
  request: ClientRequest,
  operation: SharedArtifactOperation,
  namespace: string,
  input: {
    artifact: SharedArtifact;
    view: SharedMarkdownView;
    reply: SharedArtifactDraftReply;
    body: string;
    recipient: CollectiveRecipient;
    humanId: string;
  },
) {
  const { artifact, view, reply, body, recipient, humanId } = input;
  if (
    !view.view.canReply ||
    reply.artifactId !== artifact.artifactId ||
    reply.ownerRevision !== view.ownerRevision ||
    reply.blobDigest !== view.blobDigest
  )
    throw new Error('批注引用已不可用；你写的话仍在。');
  const intent = {
    artifactId: artifact.artifactId,
    ownerRevision: view.ownerRevision,
    blobDigest: view.blobDigest,
    annotationId: reply.annotationId,
    parentEventId: reply.messageEventId,
    humanId,
    body,
    recipient,
  };
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(intent))));
  const key = `collective-annotation-reply:${namespace}:${Array.from(hash, (item) => item.toString(16).padStart(2, '0')).join('')}`;
  const saved = localStorage.getItem(key);
  const pending = z
    .object({
      id: z.string().uuid(),
      intent: z.record(z.unknown()),
      revision: z.number().int().positive(),
      conflict: z.boolean(),
    })
    .strict()
    .parse(
      saved
        ? JSON.parse(saved)
        : { id: crypto.randomUUID(), intent, revision: view.view.review.revision, conflict: false },
    );
  if (JSON.stringify(pending.intent) !== JSON.stringify(intent)) throw new Error('批注引用已改变，请重新读取。');
  if (pending.conflict) pending.revision = view.view.review.revision;
  pending.conflict = false;
  localStorage.setItem(key, JSON.stringify(pending));
  const source = await request<{ eventId: string }>('/api/events/human', {
    method: 'POST',
    body: JSON.stringify({
      serviceInstanceId: artifact.serviceInstanceId,
      collectiveId: artifact.collectiveId,
      clientEventId: pending.id,
      body,
      recipient,
      replyToEventId: reply.messageEventId,
      location: {
        channelId: artifact.sourceLocation.channelId,
        rootEventId: artifact.sourceLocation.rootEventId ?? artifact.sourceEventId,
      },
    }),
  });
  try {
    verifyReceipt(
      await operation(
        artifact,
        'annotate',
        {
          kind: 'review-action',
          expectedReviewRevision: pending.revision,
          action: { kind: 'reply', annotationId: reply.annotationId, messageEventId: source.eventId },
        },
        `reply:${pending.id}`,
        view.ownerRevision,
      ),
      view,
      reply.annotationId,
      humanId,
    );
    localStorage.removeItem(key);
  } catch (error) {
    if (error instanceof CollectiveClientRequestError && error.status === 409)
      localStorage.setItem(key, JSON.stringify({ ...pending, conflict: true }));
    throw error;
  }
}

export function verifySharedAnnotationReplyPage(
  view: SharedMarkdownView,
  annotationId: string,
  offset: number,
  page: SharedMarkdownView,
) {
  const replies = page.view.replyPages?.find((item) => item.annotationId === annotationId);
  const expected = view.view.replyPages?.find((item) => item.annotationId === annotationId);
  const annotation = page.view.review.annotations.find((item) => item.id === annotationId);
  if (
    !replies ||
    !expected ||
    !annotation ||
    page.contentRef !== view.contentRef ||
    page.ownerRevision !== view.ownerRevision ||
    page.blobDigest !== view.blobDigest ||
    page.view.review.revision !== view.view.review.revision ||
    page.view.review.reviewId !== view.view.review.reviewId ||
    replies.total !== expected.total ||
    replies.offset !== offset ||
    !annotation.replies?.length ||
    offset + annotation.replies.length > replies.total ||
    (replies.nextOffset === undefined && offset + annotation.replies.length !== replies.total) ||
    (replies.nextOffset !== undefined && replies.nextOffset <= offset)
  )
    throw new Error('批注回复正在更新，请重新读取。');
  return { ...replies, replies: annotation.replies };
}
