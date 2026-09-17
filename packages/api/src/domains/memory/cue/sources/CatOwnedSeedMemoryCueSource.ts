import { z } from 'zod';
import type { AutoDreamStore } from '../../../auto-dream/AutoDreamStore.js';
import { ownedSeedSourceRevision } from '../../../auto-dream/private-seed-contract.js';
import type { MemoryCueSourceProjection } from '../MemoryCueResolverRegistry.js';
import type { CatOwnedSeedCueSource } from '../resolvers/CatOwnedSeedCueResolver.js';

export const CAT_OWNED_SEED_ANCHOR_PREFIX = 'owned-seed:';

export const catOwnedSeedDrillPayloadSchema = z
  .object({
    seedId: z.string().trim().min(1).max(200),
    claim: z.string().trim().min(1).max(4_000),
    sourceKind: z.enum(['cue', 'originated']),
    sourceCueId: z.string().trim().min(1).max(200).optional(),
    sourceRunId: z.string().trim().min(1).max(200),
    sourceRevision: z.string().trim().min(1).max(200),
    authority: z.literal('producing_cat_private_hypothesis'),
    allowedUse: z.literal('present_loop_private_intent_or_silence'),
  })
  .strict();

export function catOwnedSeedAnchor(producingCatId: string, seedId: string): string {
  return `${CAT_OWNED_SEED_ANCHOR_PREFIX}${encodeURIComponent(producingCatId)}:${encodeURIComponent(seedId)}`;
}

export function parseCatOwnedSeedAnchor(anchor: string): { producingCatId: string; seedId: string } | null {
  if (!anchor.startsWith(CAT_OWNED_SEED_ANCHOR_PREFIX)) return null;
  const parts = anchor.slice(CAT_OWNED_SEED_ANCHOR_PREFIX.length).split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const producingCatId = decodeURIComponent(parts[0]);
    const seedId = decodeURIComponent(parts[1]);
    return producingCatId && seedId ? { producingCatId, seedId } : null;
  } catch {
    return null;
  }
}

export type CatOwnedSeedMemoryCueReadResult =
  | { status: 'ok'; payload: z.infer<typeof catOwnedSeedDrillPayloadSchema> }
  | {
      status: 'not_available';
      invalidationReason: 'source_corrected' | 'source_forgotten' | 'scope_revoked' | 'superseded';
    };

export class CatOwnedSeedMemoryCueSource implements CatOwnedSeedCueSource {
  constructor(private readonly store: Pick<AutoDreamStore, 'getOwnedSeed'>) {}

  async resolve(input: {
    ownerUserId: string;
    consumerCatId: string;
    producingCatId: string;
    seedId: string;
    sourceRevision: string;
  }): Promise<MemoryCueSourceProjection | null> {
    if (input.consumerCatId !== input.producingCatId) return null;
    const seed = await this.store.getOwnedSeed(input.ownerUserId, input.producingCatId, input.seedId);
    if (!seed || seed.status !== 'owned' || ownedSeedSourceRevision(seed) !== input.sourceRevision) return null;
    return {
      title: 'One private cat-owned seed is available',
      summary:
        'Drill only if useful in this Present Loop; treat it as the producing cat’s private hypothesis, never owner or team truth.',
      anchor: catOwnedSeedAnchor(input.producingCatId, input.seedId),
      revision: input.sourceRevision,
      visibility: 'owner_private',
      drillFamily: 'owned_seed',
    };
  }

  async read(input: {
    ownerUserId: string;
    consumerCatId: string;
    anchor: string;
    expectedRevision: string;
  }): Promise<CatOwnedSeedMemoryCueReadResult> {
    const parsed = parseCatOwnedSeedAnchor(input.anchor);
    if (!parsed) return { status: 'not_available', invalidationReason: 'source_forgotten' };
    if (parsed.producingCatId !== input.consumerCatId) {
      return { status: 'not_available', invalidationReason: 'scope_revoked' };
    }
    const seed = await this.store.getOwnedSeed(input.ownerUserId, input.consumerCatId, parsed.seedId);
    if (!seed) return { status: 'not_available', invalidationReason: 'source_forgotten' };
    if (seed.status !== 'owned') return { status: 'not_available', invalidationReason: 'superseded' };
    const revision = ownedSeedSourceRevision(seed);
    if (revision !== input.expectedRevision) {
      return { status: 'not_available', invalidationReason: 'source_corrected' };
    }
    return {
      status: 'ok',
      payload: catOwnedSeedDrillPayloadSchema.parse({
        seedId: seed.seedId,
        claim: seed.claim,
        sourceKind: seed.sourceKind,
        ...(seed.sourceCueId ? { sourceCueId: seed.sourceCueId } : {}),
        sourceRunId: seed.sourceRunId,
        sourceRevision: revision,
        authority: 'producing_cat_private_hypothesis',
        allowedUse: 'present_loop_private_intent_or_silence',
      }),
    };
  }
}
