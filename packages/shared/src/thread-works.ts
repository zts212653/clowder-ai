import { messageMediaItemKey } from './types/media-publication-source.js';
import type { ThreadArtifactDTO } from './types/thread-artifact.js';

/** Select displayed versions only from owner-proven families. All input DTOs remain available for exact returns. */
export function projectThreadWorks<T extends ThreadArtifactDTO>(
  artifacts: readonly T[],
  lineageResolved: boolean,
): T[] {
  const families = new Map<string, T>();
  const ungrouped: T[] = [];
  for (const artifact of artifacts) {
    const work = lineageResolved ? artifact.work : undefined;
    const key =
      work && Number.isSafeInteger(work.ownerRevision) && work.ownerRevision > 0
        ? `work:${work.contentRef}`
        : artifact.ref
          ? JSON.stringify([artifact.type, 'threadId' in artifact ? artifact.threadId : null, artifact.ref])
          : artifact.sourceMessageId && artifact.publicationItem
            ? JSON.stringify([artifact.sourceMessageId, messageMediaItemKey(artifact.publicationItem)])
            : null;
    if (!key) {
      ungrouped.push(artifact);
      continue;
    }
    const previous = families.get(key);
    if (
      !previous ||
      (work && work.ownerRevision > (previous.work?.ownerRevision ?? 0)) ||
      ((!work || work.ownerRevision === previous.work?.ownerRevision) && artifact.createdAt > previous.createdAt)
    )
      families.set(key, artifact);
  }
  return [...families.values(), ...ungrouped].sort((left, right) => right.createdAt - left.createdAt);
}
