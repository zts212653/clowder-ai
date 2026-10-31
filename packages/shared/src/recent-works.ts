import { messageMediaItemKey } from './types/media-publication-source.js';
import type { GlobalArtifactDTO, GlobalArtifactsResponse } from './types/thread-artifact.js';

const RECENT_WORK_TYPES = new Set<GlobalArtifactDTO['type']>(['image', 'video', 'file']);

/** F232 KD-9 / F322: the single work-admission predicate shared by the bounded API and its page. */
export function isRecentWork(artifact: GlobalArtifactDTO): boolean {
  return artifact.catId !== null && RECENT_WORK_TYPES.has(artifact.type) && artifact.fileLedgerRef === undefined;
}

function publicationKey(artifact: GlobalArtifactDTO): string {
  return artifact.publicationItem ? messageMediaItemKey(artifact.publicationItem) : '';
}

function compareRecentWorks(left: GlobalArtifactDTO, right: GlobalArtifactDTO): number {
  return (
    right.createdAt - left.createdAt ||
    left.threadId.localeCompare(right.threadId) ||
    (left.sourceMessageId ?? '').localeCompare(right.sourceMessageId ?? '') ||
    publicationKey(left).localeCompare(publicationKey(right)) ||
    left.type.localeCompare(right.type) ||
    (left.ref ?? '').localeCompare(right.ref ?? '') ||
    (left.url ?? '').localeCompare(right.url ?? '') ||
    left.name.localeCompare(right.name) ||
    (left.catId ?? '').localeCompare(right.catId ?? '')
  );
}

/**
 * Collapse exact F309 work families only after a complete lineage projection,
 * then apply the user-visible card limit. Unknown lineage never manufactures a family.
 */
export function projectRecentWorks(
  artifacts: readonly GlobalArtifactDTO[],
  workLineage: GlobalArtifactsResponse['workLineage'],
  limit = 3,
): GlobalArtifactDTO[] {
  const candidates = artifacts.filter(isRecentWork).sort(compareRecentWorks);
  if (workLineage !== 'resolved') return candidates.slice(0, limit);

  const noWork: GlobalArtifactDTO[] = [];
  const workByContentRef = new Map<string, GlobalArtifactDTO>();
  for (const artifact of candidates) {
    if (!artifact.work) {
      noWork.push(artifact);
      continue;
    }
    const current = workByContentRef.get(artifact.work.contentRef);
    if (!current || artifact.work.ownerRevision > (current.work?.ownerRevision ?? -1)) {
      workByContentRef.set(artifact.work.contentRef, artifact);
    }
  }

  return [...noWork, ...workByContentRef.values()].sort(compareRecentWorks).slice(0, limit);
}
