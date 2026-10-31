import type { CollectionSensitivity } from './collection-types.js';
import type { EvidenceItem } from './interfaces.js';

export function redactForTranscript(
  items: EvidenceItem[],
  collectionSensitivity: CollectionSensitivity,
): EvidenceItem[] {
  if (collectionSensitivity === 'public' || collectionSensitivity === 'internal') {
    return items;
  }
  return items.map((item) => ({
    anchor: item.anchor,
    kind: item.kind,
    status: item.status,
    title: `[redacted — ${collectionSensitivity} collection]`,
    updatedAt: item.updatedAt,
  }));
}
