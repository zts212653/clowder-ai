import type { MatterEntryView, MatterReadDetails } from '@cat-cafe/shared';

/** Reading a summary proves only that entry was exposed, never that its linked message was read. */
export function matterReadEvidenceEntries(entries: readonly MatterEntryView[]): MatterReadDetails['entries'] {
  return entries.flatMap<MatterReadDetails['entries'][number]>((entry) => {
    if (entry.sourceStatus === 'changed') return [];
    if (entry.summary && entry.entryRevision) return [{ entryId: entry.entryId, entryRevision: entry.entryRevision }];
    return entry.quote && !('kind' in entry.source)
      ? [{ entryId: entry.entryId, sourceRevision: entry.source.sourceRevision }]
      : [];
  });
}
