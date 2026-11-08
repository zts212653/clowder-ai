import type { RecallResolverFamily } from '@cat-cafe/shared';
import type { DiscoveryReadRequest, KnowledgeDiscoverySource } from '../../knowledge-discovery.js';
import type { MemoryCueSourceProjection } from '../MemoryCueResolverRegistry.js';
import type { PreparedCoordinate } from './WorkPreparationOpportunityStore.js';

export interface PreparationSource {
  family: RecallResolverFamily;
  resolverVersion?: number;
  source: MemoryCueSourceProjection;
  matterReadDetails?: PreparedCoordinate['matterReadDetails'];
  native?: unknown;
}

/** Translate native owner items, not already formatted search responses. */
export function projectPreparationSource<Candidate, Item>(
  native: KnowledgeDiscoverySource<Candidate, Item>,
  project: (
    item: Item,
    lifetime: Pick<DiscoveryReadRequest, 'signal' | 'deadlineAt'>,
  ) => Promise<PreparationSource | null>,
): KnowledgeDiscoverySource<unknown, PreparationSource> {
  let lifetime: Pick<DiscoveryReadRequest, 'signal' | 'deadlineAt'> = {};
  const wrap = async (item: Item | null) => {
    if (!item) return null;
    const projected = await project(item, lifetime);
    return projected ? { ...projected, native: item } : null;
  };
  const eligible = native.eligible;
  const candidateKey = native.candidateKey;
  return {
    id: native.id,
    tolerateError: true,
    read: (request) => {
      lifetime = { signal: request.signal, deadlineAt: request.deadlineAt };
      return native.read(request);
    },
    eligible: eligible ? (candidate) => eligible(candidate as Candidate) : undefined,
    candidateKey: candidateKey ? (candidate) => candidateKey(candidate as Candidate) : undefined,
    project: async (candidate) => wrap(await native.project(candidate as Candidate)),
    projectWave: async (candidates) =>
      Promise.all(
        (
          await (native.projectWave
            ? native.projectWave(candidates as Candidate[])
            : Promise.all(candidates.map((candidate) => native.project(candidate as Candidate))))
        ).map(wrap),
      ),
    revalidate: async (item) =>
      wrap(native.revalidate ? await native.revalidate(item.native as Item) : (item.native as Item)),
    key: (item) => `${item.family}\0${item.source.anchor}`,
  };
}
