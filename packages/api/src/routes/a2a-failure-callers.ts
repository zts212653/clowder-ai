import type { CatId } from '@cat-cafe/shared';
import {
  normalizeOwnerAuthProvenance,
  type OwnerAuthProvenance,
} from '../domains/cats/services/owner-auth-provenance.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';

/** Resolve the recipients and their shared authority from the same exact durable source receipts. */
export async function resolveFailedResponseReturn(
  store: IMessageStore,
  response: StoredMessage,
  legacy?: { callerCatId?: CatId; ownerAuthProvenance: OwnerAuthProvenance },
): Promise<{ targetCats: CatId[]; ownerAuthProvenance: OwnerAuthProvenance }> {
  const lifecycle = response.lifecycle;
  if (lifecycle?.kind !== 'response') throw new Error('failed response lifecycle identity missing');
  const receipts = [
    ...(response.extra?.a2aFailureReturn ? [response.extra.a2aFailureReturn] : []),
    ...(response.extra?.coveredA2AFailureReturns ?? []),
  ];
  if (!receipts.length) {
    if (!legacy) throw new Error('failed response requires durable admission provenance');
    return {
      targetCats: legacy.callerCatId ? [legacy.callerCatId] : [],
      ownerAuthProvenance: normalizeOwnerAuthProvenance(legacy.ownerAuthProvenance),
    };
  }
  const callers = new Set<CatId>();
  for (const receipt of receipts) {
    const source = await store.getById(receipt.triggerMessageId);
    if (
      !source ||
      source.userId !== response.userId ||
      source.threadId !== response.threadId ||
      source.from?.kind !== 'agent' ||
      source.from.catId !== receipt.callerCatId ||
      !lifecycle.inputMessageIds.includes(source.id) ||
      !source.lifecycle?.dispatchRefs?.some(
        (ref) => ref.targetId === lifecycle.targetId && ref.statusMessageId === response.id,
      )
    )
      throw new Error('failed response covered caller identity mismatch');
    if (
      receipt.isFailureReport ||
      receipt.callerCatId === lifecycle.targetId ||
      source.visibility === 'whisper' ||
      source.deliveryStatus === 'canceled' ||
      source.recall ||
      source._tombstone ||
      source.deletedAt
    )
      continue;
    callers.add(receipt.callerCatId as CatId);
  }
  const provenances = receipts.map((receipt) => normalizeOwnerAuthProvenance(receipt.ownerAuthProvenance));
  const ownerAuthProvenance = provenances.includes('unknown')
    ? 'unknown'
    : provenances.includes('compatibility_fallback')
      ? 'compatibility_fallback'
      : 'strict';
  return { targetCats: [...callers], ownerAuthProvenance };
}
