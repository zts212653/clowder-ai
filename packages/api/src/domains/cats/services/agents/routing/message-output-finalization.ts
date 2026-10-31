import { createHash } from 'node:crypto';
import { type MessageOutputBoundaryRun, type MessageOutputLayoutV1, readMessageOutputLayout } from '@cat-cafe/shared';

/** Rebase proven last-tool ranges only for the exact trim/trimEnd used by persistence. */
export function alignTrimmedToolBoundary(
  source: string,
  published: string,
  layout: MessageOutputLayoutV1,
): MessageOutputLayoutV1 | undefined {
  if (layout.status !== 'available' || layout.basis !== 'successful_turn_last_tool') return undefined;
  const end = source.trimEnd().length;
  const start = published === source.trimEnd() ? 0 : source.length - source.trimStart().length;
  if (!published || source.slice(start, end) !== published) return undefined;

  const runs: MessageOutputBoundaryRun[] = [];
  for (const run of layout.runs) {
    const clippedStart = Math.max(start, run.start);
    const clippedEnd = Math.min(end, run.end);
    if (clippedEnd <= clippedStart) continue;
    runs.push({
      ...run,
      start: clippedStart - start,
      end: clippedEnd - start,
      gluePrefixLength: Math.max(0, Math.min(clippedEnd, run.start + run.gluePrefixLength) - clippedStart) as 0 | 1 | 2,
    });
  }
  const retained = new Set(runs.map((run) => run.id));
  return readMessageOutputLayout({
    ...layout,
    contentRevision: { length: published.length, sha256: createHash('sha256').update(published, 'utf8').digest('hex') },
    runs,
    order: layout.order.filter((ref) => ref.kind === 'tool' || retained.has(ref.runId)),
  });
}
