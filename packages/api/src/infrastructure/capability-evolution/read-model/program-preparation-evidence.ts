import type { EvolutionPreparationBodyV1, OwnerTruthRefV1 } from '@cat-cafe/shared';
import { isDelivered } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { EvolutionPreparationDependencies } from '../program-preparation-contract.js';

export interface PreparationEvidenceRead {
  sourceKey: string;
  status: 'available' | 'unavailable' | 'unverified';
  refs: Array<{
    ref: OwnerTruthRefV1;
    status: 'available' | 'unavailable' | 'unverified';
    threadId?: string;
    messageId?: string;
  }>;
}

/** A stored validity statement and availability of its current evidence are different facts. */
export async function readPreparationEvidence(
  body: EvolutionPreparationBodyV1,
  ownerUserId: string,
  dependencies: EvolutionPreparationDependencies,
): Promise<PreparationEvidenceRead[]> {
  if (body.kind !== 'measurement_plan') return [];
  const cache = new Map<string, Promise<PreparationEvidenceRead['refs'][number]>>();
  const read = (ref: OwnerTruthRefV1) => {
    const key = JSON.stringify(ref);
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = (async (): Promise<PreparationEvidenceRead['refs'][number]> => {
      // Other owners remain authoritative. An unconnected reader cannot manufacture a successful read.
      if (ref.ownerFeatureId !== 'F117' || !ref.ownerStateRef.startsWith('message:') || ref.version)
        return { ref, status: 'unverified' };
      const message = await dependencies.messageStore.getById(ref.ownerStateRef.slice('message:'.length));
      if (
        !message ||
        message.userId !== ownerUserId ||
        message.deletedAt ||
        message._tombstone ||
        message.recall ||
        !isDelivered(message) ||
        message.visibility === 'whisper' ||
        message.sourceParseFailure ||
        message.source !== undefined
      )
        return { ref, status: 'unavailable' };
      const thread = await dependencies.threadStore.get(message.threadId);
      if (!thread || thread.deletedAt || thread.createdBy !== ownerUserId) return { ref, status: 'unavailable' };
      return { ref, status: 'available', threadId: message.threadId, messageId: message.id };
    })();
    cache.set(key, pending);
    return pending;
  };
  return Promise.all(
    body.gtSources.map(async (source): Promise<PreparationEvidenceRead> => {
      const collection = source.collection.state !== 'not_connected' ? source.collection.sourceRef : undefined;
      const proofs = source.validity.state === 'unknown' ? [] : (source.validity.proofRefs ?? []);
      const refs = await Promise.all([...(collection ? [collection] : []), ...proofs].map(read));
      const status = refs.some((value) => value.status === 'unavailable')
        ? 'unavailable'
        : !collection || refs.some((value) => value.status === 'unverified')
          ? 'unverified'
          : 'available';
      return { sourceKey: source.sourceKey, status, refs };
    }),
  );
}
