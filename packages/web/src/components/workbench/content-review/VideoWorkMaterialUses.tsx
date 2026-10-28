import type { WorkContextRecord, WorkVideoContext } from '@cat-cafe/shared';
import { type StoryClock, storyTime } from './VideoWorkStory';

export type MaterialSeek = (row: WorkVideoContext['story'][number], metadataRevision: number) => void;
export interface MaterialUsageProps {
  record: WorkContextRecord;
  clock?: StoryClock & { streamId?: string };
  onSeek?: MaterialSeek;
}

/** A source note is not a timing cue. Only an explicit paragraph/chapter identity can seek. */
export function VideoWorkMaterialUses({ uses, record, clock, onSeek }: MaterialUsageProps & { uses: string[] }) {
  const context = record.context;
  const candidates = [...context.story, ...(context.chapters ?? [])].filter(
    (row) => !clock?.streamId || row.streamId === clock.streamId,
  );
  const locations = new Map<string, (typeof candidates)[number] | undefined>();
  for (const use of uses.length ? uses : ['']) {
    const matches = candidates.filter(
      (row) => use === row.id || use === row.sourceId || use === row.title || ('label' in row && use === row.label),
    );
    const row = matches.length === 1 ? matches[0] : undefined;
    locations.set(row ? `${row.streamId}:${row.id}` : 'whole-film', row);
  }
  return (
    <p className="mt-1 text-xs text-cafe-muted">
      用在 ·{' '}
      {[...locations].map(([key, row], index) => {
        if (!row) return <span key={key}>{index > 0 ? '；' : ''}全片</span>;
        const chapter = 'chapterId' in row ? context.chapters?.find((c) => c.id === row.chapterId) : undefined;
        const label = chapter?.label ?? ('label' in row ? row.label : undefined) ?? row.title;
        const text = `${storyTime(row.startPts, clock) ?? ''} ${label}`.trim();
        return (
          <span key={key}>
            {index > 0 ? '；' : ''}
            {clock && onSeek ? (
              <button
                type="button"
                className="text-cafe-accent underline"
                onClick={() => onSeek(row, record.metadataRevision)}
              >
                {text}
              </button>
            ) : (
              text
            )}
          </span>
        );
      })}
    </p>
  );
}
