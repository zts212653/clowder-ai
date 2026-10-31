import type { CatId } from '@cat-cafe/shared';
import { getRoster } from '../config/cat-config-loader.js';
import { resolveCatTarget } from '../domains/cats/services/agents/routing/cat-target-resolver.js';
import type { IBacklogStore } from '../domains/cats/services/stores/ports/BacklogStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { getFeatureTagId } from './backlog-doc-import.js';

export function normalizeFeatId(value: string): string {
  return value.trim().toUpperCase();
}

function resolveFeatureOwnerCandidate(candidate: string): CatId | undefined {
  const normalized = (candidate.startsWith('@') ? candidate.slice(1) : candidate).trim().toLowerCase();
  const rosterEntry = getRoster()[normalized];
  if (rosterEntry && rosterEntry.available !== false) return normalized as CatId;
  const resolved = resolveCatTarget(candidate);
  return 'ok' in resolved ? resolved.ok : undefined;
}

function resolveSlashSeparatedOwnerCatId(ownerWithoutAnnotations: string): CatId | undefined {
  const segments = ownerWithoutAnnotations
    .split(/[/／]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) return undefined;

  const firstResolved = resolveFeatureOwnerCandidate(segments[0]);
  if (!firstResolved) return undefined;
  const resolved = new Set<CatId>();
  const unresolved: string[] = [];
  for (const segment of segments) {
    const result = resolveFeatureOwnerCandidate(segment);
    if (result) resolved.add(result);
    else unresolved.push(segment);
  }
  if (resolved.size !== 1) return undefined;
  if (unresolved.some((segment) => /[@\u4E00-\u9FFF]/.test(segment))) return undefined;
  return firstResolved;
}

export function resolveFeatureOwnerCatId(owner: string | undefined): string | undefined {
  if (!owner) return undefined;
  const trimmed = owner.trim();
  if (!trimmed) return undefined;
  const ownerWithoutAnnotations = trimmed
    .replace(/\s*[（(][^()（）]*[）)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/[+＋、，,；;]/.test(ownerWithoutAnnotations)) return undefined;
  const slashSeparatedOwnerCatId = resolveSlashSeparatedOwnerCatId(ownerWithoutAnnotations);
  if (slashSeparatedOwnerCatId) return slashSeparatedOwnerCatId;

  const candidates = [
    trimmed,
    trimmed.match(/@[^\s,，、/+()（）]+/)?.[0],
    ownerWithoutAnnotations,
    ownerWithoutAnnotations.split(/\s+/)[0],
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));
  for (const candidate of candidates) {
    const resolved = resolveFeatureOwnerCandidate(candidate);
    if (resolved) return resolved;
  }
  return undefined;
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
