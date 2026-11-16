'use client';
import type { MatterPage } from '@cat-cafe/shared';
import Link from 'next/link';
import { useState } from 'react';
import { MemoryMatterActions } from '../memory/page/MemoryMatterActions';
import { useMemoryRead } from '../memory/page/use-memory-read';
import { useShellCopy } from '../shell/shell-copy';
import { memoryGroupCopy } from './memory-group.shell-copy';

/** Read the original owner page, including current source permissions; never keep a second content snapshot. */
export function MemoryGroupMatter({ matterId, threadId }: { matterId: string; threadId?: string }) {
  const t = useShellCopy(memoryGroupCopy);
  const read = useMemoryRead<MatterPage>(`/api/memory/matters/${encodeURIComponent(matterId)}?limit=3`);
  const [removed, setRemoved] = useState(false);
  const matter = read.data?.matter;
  const href = `/memory?matter=${encodeURIComponent(matterId)}${threadId ? `&from=${encodeURIComponent(threadId)}` : ''}`;
  if (removed) return <p role="status">{t.forgotten}</p>;
  if (read.loading) return <p role="status">{t.readingRecord}</p>;
  if (read.error || !matter || matter.matterId !== matterId)
    return (
      <div className="space-y-2 text-sm">
        <p role="status">{t.recordUnreadable}</p>
        <button type="button" className="shell-focusable text-cafe-accent underline" onClick={read.retry}>
          {t.reread}
        </button>
        <Link href={href} className="shell-focusable ml-3 text-cafe-accent underline">
          {t.viewEdit}
        </Link>
      </div>
    );
  return (
    <article className="space-y-3 break-words text-sm">
      <p className="text-xs text-cafe-muted">
        {t.kinds.matter} · {matter.status === 'retired' ? t.retired : t.saved}
      </p>
      <h4 className="font-medium">
        <Link href={href} className="shell-focusable hover:underline">
          {matter.title}
        </Link>
      </h4>
      {matter.description && (
        <div className="space-y-1">
          <p className="text-xs text-cafe-muted">{t.catDescription}</p>
          <p className="whitespace-pre-wrap leading-relaxed">{matter.description}</p>
        </div>
      )}
      {read.data?.summaryStatus === 'sources_changed' && <p role="status">{t.sourceChanged}</p>}
      <details className="space-y-2 text-xs text-cafe-muted">
        <summary className="shell-focusable cursor-pointer">{t.sources}</summary>
        {read.data?.entries.map((entry) => (
          <div key={entry.entryId} className="space-y-1">
            <p>
              {entry.attribution === 'author' && entry.source.author.kind === 'user' ? t.yourWords : t.sourceMessage}
            </p>
            {entry.sourceStatus === 'current' ? (
              <blockquote className="whitespace-pre-wrap text-sm">{entry.quote}</blockquote>
            ) : (
              <p>{t.sourceChanged}</p>
            )}
            <Link
              href={`/thread/${encodeURIComponent(entry.source.threadId)}?message=${encodeURIComponent(entry.source.messageId)}`}
              className="shell-focusable inline-block py-1 text-cafe-accent underline"
            >
              {t.viewSource}
            </Link>
          </div>
        ))}
      </details>
      <Link href={href} className="shell-focusable inline-block py-1 text-cafe-accent underline">
        {t.viewEdit}
      </Link>
      <button type="button" className="shell-focusable ml-3 text-cafe-muted underline" onClick={read.retry}>
        {t.refreshRecord}
      </button>
      <MemoryMatterActions
        key={matter.revision}
        matter={matter}
        onChanged={(receipt) => (receipt.outcome === 'forgotten' ? setRemoved(true) : read.retry())}
      />
    </article>
  );
}
