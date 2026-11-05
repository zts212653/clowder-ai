import { type GlobalArtifactDTO, type GlobalArtifactsResponse, messageMediaItemKey } from '@cat-cafe/shared';

type Lineage = GlobalArtifactsResponse['workLineage'];

export function mergeArtifactPages(
  previous: readonly GlobalArtifactDTO[],
  incoming: readonly GlobalArtifactDTO[],
  lineage: Lineage,
) {
  const rows = new Map<string, GlobalArtifactDTO>();
  const unidentified: GlobalArtifactDTO[] = [];
  for (const item of [...previous, ...incoming]) {
    // Exact original return coordinates, not guessed work families. Consumers retain their original F309 projection.
    const publication =
      item.sourceMessageId && item.publicationItem ? messageMediaItemKey(item.publicationItem) : undefined;
    const key =
      publication || item.ref
        ? JSON.stringify([item.threadId, item.sourceMessageId, item.type, publication ?? item.ref])
        : null;
    const value = { ...item };
    if (lineage === 'unavailable') delete value.work;
    if (!key) {
      unidentified.push(value);
      continue;
    }
    const previous = rows.get(key);
    if (previous && previous.createdAt > item.createdAt) continue;
    rows.set(key, value);
  }
  return [...rows.values(), ...unidentified].sort(
    (a, b) =>
      b.createdAt - a.createdAt ||
      a.threadId.localeCompare(b.threadId) ||
      (a.sourceMessageId ?? '').localeCompare(b.sourceMessageId ?? '') ||
      (a.publicationItem ? messageMediaItemKey(a.publicationItem) : '').localeCompare(
        b.publicationItem ? messageMediaItemKey(b.publicationItem) : '',
      ),
  );
}
