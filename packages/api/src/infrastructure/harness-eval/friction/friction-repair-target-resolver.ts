import { createHash } from 'node:crypto';
import type { IBacklogStore } from '../../../domains/cats/services/stores/ports/BacklogStore.js';
import type { IThreadStore } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import type { FeatIndexEntry } from '../../../routes/feat-index-doc-import.js';
import { readFeatIndexEntries } from '../../../routes/feat-index-doc-import.js';
import {
  buildThreadIdsByFeatId,
  normalizeFeatId,
  resolveFeatureOwnerCatId,
} from '../../../routes/feature-thread-resolver.js';
import {
  type FrictionRepairTargetResolution,
  type RepairTargetHintV1,
  type ResolvedRepairTargetV1,
  ResolvedRepairTargetV1Schema,
} from './friction-finding-artifact.js';

export interface FrictionRepairTargetResolverDeps {
  threadStore?: IThreadStore;
  backlogStore?: IBacklogStore;
  featureIndexProvider?: () => Promise<FeatIndexEntry[]>;
  logger: { warn: (obj: unknown, msg?: string) => void };
}

export interface ResolveFrictionRepairTargetInput {
  userId: string;
  hint: RepairTargetHintV1;
  resolvedAt: string;
  expectedOwnerCatId?: string;
}

export interface RevalidateFrictionRepairTargetInput {
  userId: string;
  target: ResolvedRepairTargetV1;
  resolvedAt: string;
}

export interface FrictionRepairTargetResolver {
  resolve(input: ResolveFrictionRepairTargetInput): Promise<FrictionRepairTargetResolution>;
  revalidate(input: RevalidateFrictionRepairTargetInput): Promise<FrictionRepairTargetResolution>;
}

export function createFrictionRepairTargetResolver(
  deps: FrictionRepairTargetResolverDeps,
): FrictionRepairTargetResolver {
  const featureIndexProvider = deps.featureIndexProvider ?? readFeatIndexEntries;

  const resolve = async (input: ResolveFrictionRepairTargetInput): Promise<FrictionRepairTargetResolution> => {
    const featureId = normalizeFeatId(input.hint.featureId);
    const entries = (await featureIndexProvider()).filter((entry) => normalizeFeatId(entry.featId) === featureId);
    const ownerResolution = resolveCanonicalFeatureOwner(entries, featureId, input.expectedOwnerCatId);
    if (ownerResolution.status === 'blocked') return ownerResolution;

    const threadIds =
      (await buildThreadIdsByFeatId(deps.threadStore, deps.backlogStore, input.userId, deps.logger)).get(featureId) ??
      [];
    const threadResolution = resolveCanonicalFeatureThread(threadIds, featureId);
    if (threadResolution.status === 'blocked') return threadResolution;

    const { ownerCatId } = ownerResolution;
    const resolutionRef = `feature-thread-owner:v1:${featureId}:${threadResolution.threadId}:${ownerCatId}`;
    const versionDigest = createHash('sha256')
      .update([featureId, input.hint.componentId ?? '', ownerCatId, resolutionRef].join('\u001f'), 'utf8')
      .digest('hex');
    return {
      status: 'resolved',
      target: ResolvedRepairTargetV1Schema.parse({
        featureId,
        ...(input.hint.componentId ? { componentId: input.hint.componentId } : {}),
        ownerCatId,
        version: `repair-target-v1-${versionDigest}`,
        resolutionRef,
        resolvedAt: input.resolvedAt,
      }),
    };
  };

  return {
    resolve,
    async revalidate(input) {
      const current = await resolve({
        userId: input.userId,
        hint: {
          featureId: input.target.featureId,
          ...(input.target.componentId ? { componentId: input.target.componentId } : {}),
        },
        resolvedAt: input.resolvedAt,
      });
      if (current.status === 'blocked') return current;
      if (current.target.version !== input.target.version) {
        return blocked(
          'target_mismatch',
          `stale-target:${input.target.version}:current:${current.target.version}:${current.target.resolutionRef}`,
        );
      }
      return current;
    },
  };
}

function resolveCanonicalFeatureOwner(
  entries: readonly FeatIndexEntry[],
  featureId: string,
  expectedOwnerCatId?: string,
): { status: 'resolved'; ownerCatId: string } | Extract<FrictionRepairTargetResolution, { status: 'blocked' }> {
  if (entries.length === 0) return blocked('owner_unresolved', `feature-index:${featureId}:not-found`);
  if (entries.length !== 1) return blocked('owner_ambiguous', `feature-index:${featureId}:matches:${entries.length}`);
  const entry = entries[0];
  if (!entry?.owner) return blocked('owner_unresolved', `feature-index:${featureId}:owner-missing`);
  const ownerCatId = resolveFeatureOwnerCatId(entry.owner);
  if (!ownerCatId) return blocked('owner_ambiguous', `feature-index:${featureId}:owner:${entry.owner}`);
  if (expectedOwnerCatId && expectedOwnerCatId !== ownerCatId) {
    return blocked(
      'target_mismatch',
      `feature-index:${featureId}:expected-owner:${expectedOwnerCatId}:actual:${ownerCatId}`,
    );
  }
  return { status: 'resolved', ownerCatId };
}

function resolveCanonicalFeatureThread(
  threadIds: readonly string[],
  featureId: string,
): { status: 'resolved'; threadId: string } | Extract<FrictionRepairTargetResolution, { status: 'blocked' }> {
  if (threadIds.length === 0) return blocked('owner_unresolved', `feature-thread:${featureId}:not-found`);
  if (threadIds.length !== 1) {
    return blocked('owner_ambiguous', `feature-thread:${featureId}:ambiguous:${threadIds.join(',')}`);
  }
  return { status: 'resolved', threadId: threadIds[0] as string };
}

function blocked(
  reason: Extract<FrictionRepairTargetResolution, { status: 'blocked' }>['reason'],
  evidenceRef: string,
): Extract<FrictionRepairTargetResolution, { status: 'blocked' }> {
  return { status: 'blocked', reason, evidenceRef };
}
