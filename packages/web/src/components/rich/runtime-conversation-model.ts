import {
  type RuntimeConversationDecisionRequest,
  type RuntimeConversationResponse,
  type RuntimeInteractionCardRef,
  type RuntimeInteractionRecord,
  runtimeConversationDecisionRequestSchema,
} from '@cat-cafe/shared';
import { readApprovalProducerBody } from '@/lib/approval-producer-read';
import { readFreshApprovalResultOwner } from '@/lib/approval-result-owner';
import type { RichInteractiveBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';

export interface RuntimeConversationBinding {
  version: 1;
  interactionId: string;
  blockId: string;
  requestKind: 'conversation_decision';
}
export type RuntimeConversationContext = import('@/stores/chat-types').RuntimeConversationAnswerContext;
export type ConversationRecord = RuntimeInteractionRecord & {
  request: RuntimeConversationDecisionRequest;
  cardRef: RuntimeInteractionCardRef;
};
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
export function readConversationRecord(value: unknown): ConversationRecord | null {
  if (!object(value)) return null;
  const request = runtimeConversationDecisionRequestSchema.safeParse(value.request);
  if (!request.success || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return null;
  const { owner } = request.data;
  if (
    !object(value.source) ||
    value.source.kind !== 'conversation_decision' ||
    value.source.requesterCatId !== owner.catId ||
    value.source.requesterThreadId !== owner.threadId ||
    value.source.requesterInvocationId !== owner.invocationId
  )
    return null;
  if (
    !object(value.returnBinding) ||
    value.returnBinding.kind !== 'conversation_turn' ||
    value.returnBinding.requesterCatId !== owner.catId ||
    value.returnBinding.requesterThreadId !== owner.threadId
  )
    return null;
  if (
    !object(value.cardRef) ||
    value.cardRef.threadId !== owner.threadId ||
    !nonBlank(value.cardRef.messageId) ||
    value.cardRef.blockId !== request.data.presentation.id ||
    typeof value.cardRef.blockDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.cardRef.blockDigest) ||
    !Number.isSafeInteger(value.cardRef.publishedAt) ||
    Number(value.cardRef.publishedAt) < 0
  )
    return null;
  if (!['pending', 'answered', 'declined', 'cancelled', 'invalidated'].includes(String(value.status))) return null;
  if (
    value.status !== 'pending' &&
    (!object(value.terminal) ||
      value.terminal.status !== value.status ||
      !Number.isSafeInteger(value.terminal.settledAt))
  )
    return null;
  return { ...value, request: request.data } as ConversationRecord;
}
export function sameConversationCard(a: RuntimeInteractionCardRef, b: RuntimeInteractionCardRef): boolean {
  return (
    a.threadId === b.threadId &&
    a.messageId === b.messageId &&
    a.blockId === b.blockId &&
    a.blockDigest === b.blockDigest &&
    a.publishedAt === b.publishedAt
  );
}
/** Property order is transport detail; every presentation field must still match. */
export function sameConversationPresentation(a: RichInteractiveBlock, b: RichInteractiveBlock): boolean {
  function sorted(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sorted);
    if (object(v))
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sorted(v[k])]),
      );
    return v;
  }
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}
export async function readConversation(interactionId: string, shared = false): Promise<ConversationRecord | null> {
  const owner = apiSessionIdentity.getSnapshot().ownerUserId;
  if (shared && owner) {
    const body = await readApprovalProducerBody(
      { owner, producer: 'F306', proposalId: interactionId },
      `/api/runtime-interactions/${encodeURIComponent(interactionId)}`,
    );
    return object(body) ? readConversationRecord(body.interaction) : null;
  }
  const response = await apiFetch(
    `/api/runtime-interactions/${encodeURIComponent(interactionId)}`,
    {},
    { afterCurrentGet: true },
  );
  const body: unknown = response.ok ? await response.json() : null;
  return object(body) ? readConversationRecord(body.interaction) : null;
}

export const readConversationOwner = readFreshApprovalResultOwner;
export async function submitConversationAnswer(
  context: RuntimeConversationContext,
  answer: RuntimeConversationResponse,
  verifyCurrentRead?: () => boolean,
): Promise<ConversationRecord> {
  const [record, owner] = await Promise.all([readConversation(context.interactionId), readConversationOwner()]);
  if (
    !record ||
    owner !== context.ownerUserId ||
    record.request.owner.userId !== owner ||
    !sameConversationCard(record.cardRef, context.cardRef)
  )
    throw new Error('changed');
  if (record.status !== 'pending') {
    if (record.terminal?.operationId === context.operationId) return record;
    throw new Error('changed');
  }
  if (verifyCurrentRead && !verifyCurrentRead()) throw new Error('changed');
  if (record.submission && record.submission.operationId !== context.operationId) throw new Error('changed');
  if (record.revision !== context.expectedRevision && record.submission?.operationId !== context.operationId)
    throw new Error('changed');
  const response = await apiFetch(`/api/runtime-interactions/${encodeURIComponent(context.interactionId)}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cardRef: context.cardRef,
      expectedRevision: context.expectedRevision,
      operationId: context.operationId,
      response: answer,
    }),
  });
  const body: unknown = await response.json();
  const result = object(body) ? readConversationRecord(body.interaction) : null;
  if (
    !response.ok ||
    !result ||
    result.request.owner.userId !== owner ||
    !sameConversationCard(result.cardRef, context.cardRef) ||
    result.terminal?.operationId !== context.operationId
  )
    throw new Error('changed');
  window.dispatchEvent(
    new CustomEvent('cat-cafe:runtime-interaction-updated', { detail: { interactionId: context.interactionId } }),
  );
  return result;
}
