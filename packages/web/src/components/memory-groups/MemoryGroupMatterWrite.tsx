'use client';
import type { MatterWriteRef, MatterWriteSnapshot } from '@cat-cafe/shared';
import Link from 'next/link';
import { useEffect } from 'react';
import { MATTER_MEMORY_CHANGED } from '@/hooks/matter-memory-events';
import { MatterEntryContent, MatterSummaryAuthor } from '../memory/page/MatterEntryContent';
import { formatMemoryDate, useMemoryRead } from '../memory/page/use-memory-read';
import { useShellCopy } from '../shell/shell-copy';
import { matterWriteDiff } from './matter-write-diff';
import { memoryGroupCopy } from './memory-group.shell-copy';

/** The original write receipt owns fixed content. Every read still rechecks the canonical page's permissions. */
export function MemoryGroupMatterWrite({
  matterId,
  writeRef,
  threadId,
}: {
  matterId: string;
  writeRef: MatterWriteRef;
  threadId?: string;
}) {
  const t = useShellCopy(memoryGroupCopy);
  const params = new URLSearchParams({ actorKey: writeRef.actorKey, requestId: writeRef.requestId });
  const read = useMemoryRead<MatterWriteSnapshot>(
    `/api/memory/matters/${encodeURIComponent(matterId)}/write-receipt?${params}`,
  );
  useEffect(() => {
    window.addEventListener(MATTER_MEMORY_CHANGED, read.retry);
    return () => window.removeEventListener(MATTER_MEMORY_CHANGED, read.retry);
  }, [read.retry]);
  const saved = read.data;
  const href = `/memory?matter=${encodeURIComponent(matterId)}${threadId ? `&from=${encodeURIComponent(threadId)}` : ''}`;
  const retry = (
    <button type="button" className="shell-focusable text-cafe-accent underline" onClick={read.retry}>
      {t.reread}
    </button>
  );
  if (read.loading) return <p role="status">{t.readingRecord}</p>;
  if (
    read.error ||
    !saved ||
    saved.matter.matterId !== matterId ||
    saved.matter.revision !== writeRef.revision ||
    saved.operation !== writeRef.operation
  )
    return (
      <div className="space-y-2 text-sm">
        <p role="status">{t.recordUnreadable}</p>
        {retry}
      </div>
    );
  const description = saved.descriptionChange;
  const showDescription =
    description &&
    !(saved.operation === 'create' && saved.entries.some((entry) => entry.summary === description.after));
  const diff = description ? matterWriteDiff(description.before, description.after) : undefined;
  return (
    <article className="space-y-3 break-words text-sm">
      <p className="text-xs text-cafe-muted">
        {t.matterOperations[saved.operation]} · {t.writeRevision(saved.matter.revision)} ·{' '}
        {formatMemoryDate(saved.recordedAt)}
      </p>
      <h4 className="font-medium">
        <Link href={href} className="shell-focusable hover:underline">
          {saved.matter.title}
        </Link>
      </h4>
      {saved.sourcesChanged && <p className="text-xs text-cafe-muted">{t.sourceChanged}</p>}
      {saved.titleChange && (
        <div className="space-y-1">
          <p className="text-xs text-cafe-muted">{t.changedTitle}</p>
          <del className="block whitespace-pre-wrap text-cafe-muted">{saved.titleChange.before}</del>
          <ins className="block whitespace-pre-wrap no-underline">{saved.titleChange.after}</ins>
        </div>
      )}
      {showDescription && diff && (
        <div className="space-y-1">
          <p className="text-xs text-cafe-muted">
            <MatterSummaryAuthor author={description.author} />
          </p>
          {diff.removed && (
            <div>
              <p className="text-xs text-cafe-muted">{t.removedText}</p>
              <del className="block whitespace-pre-wrap text-cafe-muted">{diff.removed}</del>
            </div>
          )}
          {diff.added && (
            <div>
              <p className="text-xs text-cafe-muted">{t.addedText}</p>
              <ins className="block whitespace-pre-wrap no-underline">{diff.added}</ins>
            </div>
          )}
        </div>
      )}
      {saved.entries.map((entry) => (
        <MatterEntryContent key={entry.entryId} entry={entry} />
      ))}
      {saved.previousEntries?.length ? (
        <details className="text-xs text-cafe-muted">
          <summary className="shell-focusable cursor-pointer">{t.beforeCorrection}</summary>
          {saved.previousEntries.map((entry) => (
            <MatterEntryContent key={entry.entryId} entry={entry} />
          ))}
        </details>
      ) : null}
      {!saved.entries.length && !saved.titleChange && !showDescription && saved.operation === 'append' && (
        <p>{t.joined}</p>
      )}
      <div className="flex gap-4 text-xs">
        <Link href={href} className="shell-focusable text-cafe-accent underline">
          {t.viewCurrentPage}
        </Link>
        {retry}
      </div>
    </article>
  );
}
