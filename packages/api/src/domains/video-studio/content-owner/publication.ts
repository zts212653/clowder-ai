import type { ContentPublicationScopeV1, ContentSourcePublicationV1 } from './types.js';

export function samePublicationScope(
  left: ContentPublicationScopeV1 | undefined,
  right: ContentPublicationScopeV1,
): boolean {
  return left?.ownerUserId === right.ownerUserId && left.threadId === right.threadId && left.taskId === right.taskId;
}

/** Provenance is supplied only by the publication reader, never from a browser actor claim. */
export function validateContentPublication(
  scope: ContentPublicationScopeV1 | undefined,
  publication: ContentSourcePublicationV1 | undefined,
): void {
  if (!scope && !publication) return;
  if (!scope || !publication) throw new TypeError('Media publication requires both source and authority scope');
  for (const value of [
    scope.ownerUserId,
    scope.threadId,
    scope.taskId,
    publication.artifactRef,
    publication.sourceRef,
    publication.revision,
  ]) {
    if (typeof value !== 'string' || !value || value.length > 2048 || value.trim() !== value || value.includes('\0')) {
      throw new TypeError('Invalid content publication identity');
    }
  }
  if (!publication.sourceRef.startsWith(`message:${scope.threadId}:`)) {
    throw new TypeError('Publication source belongs to another thread');
  }
}
