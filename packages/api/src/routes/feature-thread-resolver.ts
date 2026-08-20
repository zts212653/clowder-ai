import type { IBacklogStore } from '../domains/cats/services/stores/ports/BacklogStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { getFeatureTagId } from './backlog-doc-import.js';

export function normalizeFeatId(value: string): string {
  return value.trim().toUpperCase();
}

export type FeatureThreadResolutionErrorCode = 'feature_thread_not_found' | 'feature_thread_ambiguous';

export class FeatureThreadResolutionError extends Error {
  override readonly name = 'FeatureThreadResolutionError';

  constructor(
    readonly code: FeatureThreadResolutionErrorCode,
    readonly featureId: string,
    readonly candidateThreadIds: readonly string[],
  ) {
    super(`${code}:${featureId}${candidateThreadIds.length > 0 ? `:${candidateThreadIds.join(',')}` : ''}`);
  }
}

export async function buildThreadIdsByFeatId(
  threadStore: IThreadStore | undefined,
  backlogStore: IBacklogStore | undefined,
  userId: string,
  logger: { warn: (obj: unknown, msg?: string) => void },
): Promise<Map<string, string[]>> {
  const mapped = new Map<string, string[]>();
  if (!threadStore || !backlogStore) return mapped;

  try {
    const threads = await threadStore.list(userId);
    for (const thread of threads) {
      if (!thread.backlogItemId) continue;
      const backlogItem = await backlogStore.get(thread.backlogItemId, userId);
      if (!backlogItem) continue;
      const featureTagId = getFeatureTagId(backlogItem.tags);
      if (!featureTagId) continue;
      const featId = normalizeFeatId(featureTagId);
      if (featId.length === 0) continue;
      const existing = mapped.get(featId);
      if (!existing) {
        mapped.set(featId, [thread.id]);
        continue;
      }
      if (!existing.includes(thread.id)) existing.push(thread.id);
    }
  } catch (err) {
    logger.warn({ err, userId }, '[feature-thread-resolver] threadIds enrichment degraded');
  }
  return mapped;
}

export async function resolveUniqueFeatureThreadId(
  threadStore: IThreadStore | undefined,
  backlogStore: IBacklogStore | undefined,
  userId: string,
  featureId: string,
  logger: { warn: (obj: unknown, msg?: string) => void },
): Promise<string> {
  const normalized = normalizeFeatId(featureId);
  const candidates = (await buildThreadIdsByFeatId(threadStore, backlogStore, userId, logger)).get(normalized) ?? [];
  if (candidates.length === 0) throw new FeatureThreadResolutionError('feature_thread_not_found', normalized, []);
  if (candidates.length > 1) throw new FeatureThreadResolutionError('feature_thread_ambiguous', normalized, candidates);
  return candidates[0];
}
