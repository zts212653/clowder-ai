import {
  type RuntimeInteractionRecord,
  runtimeInteractionRequestSchema,
  runtimeTerminalDisposition,
  type SettledApprovalHubItem,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { readConversationRecord } from '@/components/rich/runtime-conversation-model';
import { apiFetch } from '@/utils/api-client';

const ids = z.array(z.string());
const responseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('decision'), decisionId: z.string(), submittedFieldIds: ids.optional() }),
  z.object({
    kind: z.literal('answers'),
    answeredQuestionIds: ids,
    secretQuestionIds: ids,
    selectedOptionIndexes: z.record(z.array(z.number().int().nonnegative())).optional(),
  }),
  z.object({ kind: z.literal('selection'), selectedIds: ids }),
  z.object({ kind: z.literal('text') }),
]);
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, sorted(v)]),
    );
  return value;
}
const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const statusSchema = z.enum(['answered', 'declined', 'cancelled', 'invalidated']);
const schema = z.object({
  request: runtimeInteractionRequestSchema,
  source: z.record(z.unknown()),
  returnBinding: z.record(z.unknown()),
  revision: z.number().int().positive(),
  updatedAt: z.number().finite(),
  hostEpoch: z.string(),
  status: statusSchema,
  cardRef: z.object({
    threadId: z.string(),
    messageId: z.string(),
    blockId: z.string(),
    blockDigest: z.string().optional(),
    publishedAt: z.number().optional(),
  }),
  terminal: z.object({
    status: statusSchema,
    settledAt: z.number().finite(),
    reasonCode: z.enum([
      'answered',
      'user_rejected',
      'user_cancelled',
      'confirmation_unavailable',
      'host_restarted',
      'transport_lost',
      'provider_cancelled',
      'surface_publication_failed',
      'withdrawn',
      'superseded',
      'defaulted',
      'expired',
    ]),
    response: responseSchema.optional(),
  }),
});

/** Exact current owner, publication, source, revision and terminal; stale/reopened records remain unknown and read-only. */
export function settledRuntimeRecord(value: unknown, item: SettledApprovalHubItem): RuntimeInteractionRecord | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success || item.navigation.state !== 'anchored') return null;
  const record = parsed.data,
    request = record.request,
    detail = item.detail;
  if (
    request.owner.userId !== item.ownerUserId ||
    request.owner.catId !== item.requesterCatId ||
    request.interactionId !== item.proposalId ||
    request.createdAt !== item.createdAt ||
    request.owner.threadId !== record.cardRef.threadId ||
    record.cardRef.threadId !== item.navigation.approvalCardRef.threadId ||
    record.cardRef.messageId !== item.navigation.approvalCardRef.messageId ||
    record.revision !== detail.runtimeRevision ||
    record.updatedAt !== detail.runtimeUpdatedAt ||
    request.kind !== detail.runtimeKind ||
    record.status !== record.terminal.status ||
    record.terminal.settledAt !== item.decidedAt ||
    !same(record.cardRef, detail.runtimeCardRef) ||
    !same(record.source, detail.runtimeSource) ||
    !same(record.returnBinding, detail.runtimeReturnBinding)
  )
    return null;
  const disposition = runtimeTerminalDisposition(record as RuntimeInteractionRecord);
  const resolution =
    disposition === 'approved' ? 'accepted' : disposition === 'rejected' ? 'rejected' : 'closed_without_decision';
  if (resolution !== item.resolution) return null;
  if (request.kind === 'conversation_decision') return readConversationRecord(record);
  if (
    record.source.kind !== 'provider_request' ||
    record.returnBinding.kind !== 'provider_waiter' ||
    !same(record.source.provider, request.provider)
  )
    return null;
  // The schema deliberately strips all private or unknown response fields before presentation.
  return record as RuntimeInteractionRecord;
}

export async function readSettledRuntime(item: SettledApprovalHubItem, signal: AbortSignal) {
  const response = await apiFetch(
    `/api/runtime-interactions/${encodeURIComponent(item.proposalId)}`,
    { signal },
    { afterCurrentGet: true },
  );
  const body: unknown = response.ok ? await response.json() : null;
  return body && typeof body === 'object' && 'interaction' in body
    ? settledRuntimeRecord(body.interaction, item)
    : null;
}
