import { type MessageMediaItemSelector, messageMediaItemKey, type ThreadArtifactDTO } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';

export async function resolvePublishedFile(
  url: string,
  threadId: string,
  sourceIds: readonly string[],
  signal: AbortSignal,
  item?: MessageMediaItemSelector,
) {
  const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/artifacts`, { signal });
  if (!response.ok) throw new Error('publication_unavailable');
  const body = (await response.json()) as { artifacts?: ThreadArtifactDTO[] };
  const candidates = Array.isArray(body.artifacts)
    ? body.artifacts.filter(
        (artifact) =>
          !['pr', 'widget'].includes(artifact.type) &&
          artifact.url === url &&
          sourceIds.includes(artifact.sourceMessageId ?? ''),
      )
    : [];
  const exact = item
    ? candidates.filter(
        (artifact) =>
          artifact.publicationItem && messageMediaItemKey(artifact.publicationItem) === messageMediaItemKey(item),
      )
    : candidates;
  if (exact.length === 1) return exact[0];
  // Pre-coordinate catalogue records remain readable only when the original message/URL tuple is unique.
  if (!exact.length && candidates.length === 1 && !candidates[0].publicationItem) return candidates[0];
  throw new Error('publication_unresolved');
}
