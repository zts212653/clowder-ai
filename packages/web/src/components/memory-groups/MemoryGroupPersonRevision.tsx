'use client';
import Link from 'next/link';
import { MemoryPersonClaimText } from '../memory/page/MemoryPersonClaimText';
import { MemoryPersonSource } from '../memory/page/MemoryPersonSource';
import { isPersonDetail, type PersonDetail } from '../memory/page/people-types';
import { useMemoryRead } from '../memory/page/use-memory-read';
import { useShellCopy } from '../shell/shell-copy';
import { memoryGroupCopy } from './memory-group.shell-copy';

export function MemoryGroupPersonRevision({
  personId,
  resultRef,
  threadId,
}: {
  personId: string;
  resultRef: string;
  threadId?: string;
}) {
  const t = useShellCopy(memoryGroupCopy);
  const read = useMemoryRead<PersonDetail>(`/api/memory/people/${encodeURIComponent(personId)}`, isPersonDetail);
  const person = read.data;
  const href = `/memory?family=person&memoryId=${encodeURIComponent(personId)}${threadId ? `&from=${encodeURIComponent(threadId)}` : ''}`;
  if (read.loading) return <p role="status">{t.readingRecord}</p>;
  if (read.error || !person || person.personId !== personId)
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
  const claim = person.claims.find((item) => item.claimId === resultRef);
  const event = person.interactions.find((item) => item.eventId === resultRef);
  const entry = claim ?? event;
  const forgotten = entry?.status === 'redacted';
  return (
    <article className="space-y-3 break-words text-sm">
      <p className="text-xs text-cafe-muted">
        {t.kinds.person_revision} · {t.revised}
      </p>
      <h4 className="font-medium">{person.displayName}</h4>
      {forgotten ? (
        <p>{t.forgotten}</p>
      ) : claim ? (
        <MemoryPersonClaimText claim={claim} />
      ) : event ? (
        <div className="space-y-2">
          <p className="whitespace-pre-wrap">{event.headline}</p>
          {event.importanceOrTopic && <p className="whitespace-pre-wrap">{event.importanceOrTopic}</p>}
          {event.uncertaintyNotes?.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      ) : (
        <p role="status">{t.revisionNotListed}</p>
      )}
      {entry && (
        <p className="text-xs text-cafe-muted">
          {forgotten
            ? t.forgotten
            : entry.status === 'retired'
              ? t.retired
              : entry.status === 'superseded'
                ? t.historical
                : t.currentRecord}
        </p>
      )}
      {entry && !forgotten && (
        <MemoryPersonSource personId={personId} kind={claim ? 'claim' : 'event'} itemId={resultRef} />
      )}
      <Link href={href} className="shell-focusable inline-block py-1 text-cafe-accent underline">
        {t.viewEdit}
      </Link>
    </article>
  );
}
