import { getExplicitApprovedTasteTriggerBySourcePath } from '../domains/memory/cue/ExplicitApprovedTasteTriggerCatalog.js';
import { F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1 } from '../domains/memory/cue/TasteTaskBundleCatalog.js';
import type { TasteMemoryReadResult } from '../domains/memory/taste/TasteMemoryReader.js';
import type { TasteObservatorySnapshot } from '../domains/memory/taste/TasteObservatoryReader.js';
import { tasteMemoryId } from '../domains/memory/taste/taste-memory-identity.js';

type ObservatoryEntry = TasteObservatorySnapshot['entries'][number];
export type TasteRecallView = {
  namedDelivery: {
    counts: NonNullable<ObservatoryEntry['namedDelivery']>['counts'];
    latest: { threadId: string; at: number; outcome: string } | null;
  } | null;
  search:
    | (Pick<NonNullable<ObservatoryEntry['search']>, 'hits' | 'opened' | 'unverified'> & {
        latest: { threadId: string; at: number; outcome: string } | null;
      })
    | null;
};

export { tasteMemoryId };
export { visibleTasteMemories } from './taste-browse-reader.js';

export function projectTasteMemory(
  memory: TasteMemoryReadResult,
  recall: TasteRecallView | null,
  lifecycle: {
    takeawayCandidate?: import('@cat-cafe/shared').TasteTakeawayCandidate | null;
    pendingCorrectionCount?: number;
    correctionProposals?: import('@cat-cafe/shared').TasteMemoryCorrectionProposalView[];
  } = {},
) {
  const { payload } = memory;
  const trigger = getExplicitApprovedTasteTriggerBySourcePath(memory.sourcePath);
  return {
    id: tasteMemoryId(memory.sourcePath),
    revision: memory.revision,
    status: memory.status,
    takeawayCandidate: lifecycle.takeawayCandidate ?? null,
    pendingCorrectionCount: lifecycle.pendingCorrectionCount ?? 0,
    ...(lifecycle.correctionProposals ? { correctionProposals: lifecycle.correctionProposals } : {}),
    type: 'taste' as const,
    visibility: memory.visibility,
    title: (payload.takeaway || payload.quotes[0] || '品味 · 原话没有记录下来').slice(0, 160),
    when: payload.when,
    quotes: payload.quotes,
    scene: payload.scene,
    takeaway: payload.takeaway ?? null,
    tags: payload.tags,
    dimension: payload.dimension ?? null,
    catId: payload.catId ?? null,
    whenRemembered: trigger
      ? `提到 ${trigger.triggerKey} 时点名递送这条品味`
      : F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1.sourcePaths.includes(memory.sourcePath)
        ? '进入 F315 工作区可读性审查时点名递送'
        : '只在维度提示或猫主动检索时出现',
    recall,
  };
}

/** Export no source paths, cue ids or unverified navigation coordinates. */
export function projectTasteRecall(entry: ObservatoryEntry | undefined): TasteRecallView | null {
  if (!entry) return null;
  return {
    namedDelivery: entry.namedDelivery
      ? {
          counts: entry.namedDelivery.counts,
          latest: entry.namedDelivery.latest
            ? {
                threadId: entry.namedDelivery.latest.threadId,
                at: entry.namedDelivery.latest.presentedAt,
                outcome: entry.namedDelivery.latest.outcome,
              }
            : null,
        }
      : null,
    search: entry.search
      ? {
          hits: entry.search.hits,
          opened: entry.search.opened,
          unverified: entry.search.unverified,
          latest: entry.search.latest
            ? {
                threadId: entry.search.latest.threadId,
                at: entry.search.latest.recalledAt,
                outcome: entry.search.latest.opened ? 'read' : 'not_read',
              }
            : null,
        }
      : null,
  };
}
