import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getExplicitApprovedTasteTriggerBySourcePath } from '../domains/memory/cue/ExplicitApprovedTasteTriggerCatalog.js';
import { F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1 } from '../domains/memory/cue/TasteTaskBundleCatalog.js';
import { TasteMemoryReader, type TasteMemoryReadResult } from '../domains/memory/taste/TasteMemoryReader.js';
import type { TasteObservatorySnapshot } from '../domains/memory/taste/TasteObservatoryReader.js';
import { resolveCanonicalTasteRoot, type TasteRepository } from '../domains/taste/services/TasteRepository.js';

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

export function tasteMemoryId(sourcePath: string): string {
  return `taste-${createHash('sha256').update(sourcePath).digest('hex').slice(0, 24)}`;
}

/** Pin canonical main once per request. Existing/new awaitable reader contracts both work. */
export async function visibleTasteMemories(repository: TasteRepository, owner: string, privateAccess: boolean) {
  const root = await resolveCanonicalTasteRoot(repository);
  const reader = new TasteMemoryReader({ canonicalRoot: () => root, approvalLockKey: () => 'read-only' }, owner);
  const directories = privateAccess ? ['docs/taste/vignettes', 'private/taste'] : ['docs/taste/vignettes'];
  const memories: TasteMemoryReadResult[] = [];
  for (const directory of directories) {
    let names: string[];
    try {
      names = await readdir(join(root, directory));
    } catch (error) {
      if (directory === 'private/taste' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.md')) continue;
      const memory = await reader.read({ ownerUserId: owner, sourcePath: `${directory}/${name}` });
      if (memory) memories.push(memory);
    }
  }
  return memories.sort(
    (a, b) => b.payload.when.localeCompare(a.payload.when) || a.sourcePath.localeCompare(b.sourcePath),
  );
}

export function projectTasteMemory(memory: TasteMemoryReadResult, recall: TasteRecallView | null) {
  const { payload } = memory;
  const trigger = getExplicitApprovedTasteTriggerBySourcePath(memory.sourcePath);
  return {
    id: tasteMemoryId(memory.sourcePath),
    revision: memory.revision,
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
