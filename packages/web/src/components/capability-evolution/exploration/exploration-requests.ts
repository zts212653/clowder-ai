import {
  evolutionExplorationReviewV1Schema,
  evolutionExplorationSelectionMatches,
  refIdentity,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { apiFetch } from '@/utils/api-client';
import { parseProgramProjection } from '../evolution-program-projection';
import { recoverRequestRecords } from '../evolution-request-persistence';
import { type ExplorationRequestContext, explorationRequestContextSchema } from './exploration-reading';
import { explorationRequestText } from './exploration-request-text';

const receiptSchema = z.object({
  status: z.enum(['queued', 'processing', 'duplicate']),
  userMessageId: z.string().min(1).max(240),
});
const recordSchema = z.object({
  clientMessageId: z.string().uuid(),
  context: explorationRequestContextSchema,
  createdAt: z.string().datetime(),
  receipt: receiptSchema.optional(),
});
export type ExplorationRequestRecord = z.infer<typeof recordSchema>;
interface RequestStore {
  records: Record<string, ExplorationRequestRecord>;
  pending: Record<string, boolean>;
  errors: Record<string, string | undefined>;
}
/** Retry intent only; delivery lives in F117, actual work and version/adoption receipts stay with their owners. */
export const useExplorationRequests = create<RequestStore>()(
  persist(() => ({ records: {}, pending: {}, errors: {} }), {
    name: 'f311-exploration-requests-v1',
    storage: createJSONStorage(() => localStorage),
    partialize: ({ records }) => ({ records }),
    merge: (persisted, current) => {
      const records = recoverRequestRecords(persisted, recordSchema);
      return records ? { ...current, records } : current;
    },
  }),
);

export { explorationIntentLabels } from './exploration-request-text';

const sameContext = (left: ExplorationRequestContext, right: ExplorationRequestContext) =>
  JSON.stringify(left) === JSON.stringify(right);

async function validateRequestTarget(context: ExplorationRequestContext): Promise<void> {
  const response = await apiFetch(`/api/capability-evolution/programs/${encodeURIComponent(context.programId)}`);
  const fresh = response.ok ? parseProgramProjection(await response.json()) : null;
  if (
    !fresh ||
    fresh.program.programId !== context.programId ||
    fresh.program.workspaceId !== context.workspaceId ||
    refIdentity(fresh.program.objectRef) !== refIdentity(context.objectRef) ||
    fresh.origin?.threadId !== context.threadId ||
    fresh.origin?.createdByCatId !== context.catId ||
    fresh.program.lifecycle !== 'active'
  )
    throw new Error('项目或发起对话已变化，原请求仍保留；请刷新后核对。');
  const selection = {
    selectedNodeRef: context.binding.nodeRef,
    ...(context.binding.experimentRef ? { selectedExperimentRef: context.binding.experimentRef } : {}),
  };
  const query = new URLSearchParams(Object.entries(selection).map(([key, value]) => [key, JSON.stringify(value)]));
  const source = await apiFetch(
    `/api/capability-evolution/programs/${encodeURIComponent(context.programId)}/exploration?${query}`,
  );
  const publication = evolutionExplorationReviewV1Schema.safeParse(source.ok ? await source.json() : null);
  if (
    !publication.success ||
    publication.data.status !== 'resolved' ||
    publication.data.programRef.ownerFeatureId !== 'F311' ||
    publication.data.programRef.ownerStateRef !== context.programId ||
    refIdentity(publication.data.objectRef) !== refIdentity(context.objectRef) ||
    !evolutionExplorationSelectionMatches(publication.data, selection)
  )
    throw new Error('发起时的版本或实验来源已不可用，尚未发送。');
  const node = publication.data.nodes.find(
    (node) => refIdentity(node.nodeRef) === refIdentity(context.binding.nodeRef),
  );
  if (
    !node ||
    node.kind !== context.binding.kind ||
    (node.kind === 'owner_version' &&
      context.binding.kind === 'owner_version' &&
      refIdentity(node.versionRef) !== refIdentity(context.binding.versionRef))
  )
    throw new Error('发起时的资产身份已变化，尚未发送。');
  if (context.draft.intent === 'adopt' && node.kind !== 'owner_version') throw new Error('公开归档不能直接采用。');
  const rosterResponse = await apiFetch('/api/cats');
  const roster = z
    .object({
      cats: z.array(z.object({ id: z.string(), roster: z.object({ available: z.boolean().optional() }).nullish() })),
    })
    .safeParse(rosterResponse.ok ? await rosterResponse.json() : null);
  if (!roster.success || !roster.data.cats.some((cat) => cat.id === context.catId && cat.roster?.available !== false))
    throw new Error('发起猫猫当前不可用，请在原对话确认接手者。');
}

export async function sendExplorationRequest(
  value: ExplorationRequestContext,
  retryId?: string,
): Promise<string | undefined> {
  const context = explorationRequestContextSchema.parse(value);
  const state = useExplorationRequests.getState();
  const existing = retryId
    ? state.records[retryId]
    : Object.values(state.records).find((record) => !record.receipt && sameContext(record.context, context));
  if (retryId && !existing) return undefined;
  if (
    existing &&
    (existing.context.workspaceId !== context.workspaceId ||
      existing.context.programId !== context.programId ||
      refIdentity(existing.context.objectRef) !== refIdentity(context.objectRef) ||
      existing.context.threadId !== context.threadId ||
      existing.context.catId !== context.catId)
  )
    return undefined;
  const record: ExplorationRequestRecord = existing ?? {
    clientMessageId: crypto.randomUUID(),
    context,
    createdAt: new Date().toISOString(),
  };
  const id = record.clientMessageId;
  if (record.receipt || state.pending[id]) return record.receipt ? id : undefined;
  if (
    Object.values(state.records).some(
      (entry) =>
        state.pending[entry.clientMessageId] &&
        entry.context.workspaceId === context.workspaceId &&
        entry.context.programId === context.programId,
    )
  )
    return undefined;
  // Persist the original target/body and canonical F117 idempotency key before any asynchronous step.
  useExplorationRequests.setState((current) => ({
    records: { ...current.records, [id]: record },
    pending: { ...current.pending, [id]: true },
    errors: { ...current.errors, [id]: undefined },
  }));
  try {
    await validateRequestTarget(record.context);
    const response = await apiFetch('/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId: record.context.threadId,
        idempotencyKey: id,
        messageDisposition: 'continue_current',
        content: explorationRequestText(record.context),
      }),
    });
    const receipt = receiptSchema.safeParse(response.ok ? await response.json() : null);
    if (!receipt.success) throw new Error('送达尚未确认，请重试同一请求。');
    useExplorationRequests.setState((current) => ({
      records: { ...current.records, [id]: { ...record, receipt: receipt.data } },
    }));
    return id;
  } catch (error) {
    useExplorationRequests.setState((current) => ({
      errors: {
        ...current.errors,
        [id]: error instanceof Error && !(error instanceof TypeError) ? error.message : '网络中断，请重试同一请求。',
      },
    }));
    return undefined;
  } finally {
    useExplorationRequests.setState((current) => ({ pending: { ...current.pending, [id]: false } }));
  }
}
