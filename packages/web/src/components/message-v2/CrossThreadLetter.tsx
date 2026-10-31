import type { ReactNode } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { formatCatDisplayName } from '@/lib/cat-display-name';
import { catColorVar } from '@/lib/cat-slug';
import { setPendingCrossPostScroll } from '@/utils/crosspost-scroll-target';
import { useShellCopy } from '../shell/shell-copy';
import { pushThreadRouteWithHistory } from '../ThreadSidebar/thread-navigation';
import { crossThreadLetterCopy } from './cross-thread-letter.shell-copy';
import { crossThreadLetterRecipients } from './cross-thread-letter-recipients';
import { useCrossThreadLetterSource } from './use-cross-thread-letter-source';

interface Props {
  sourceThreadId: string;
  sourceInvocationId?: string;
  senderCatId?: string;
  content: string;
  targetCats?: readonly string[];
  mentionsUser?: boolean;
  getCatById: (id: string) => CatData | undefined;
  children: ReactNode;
}

/** Other conversations arrive as paper; the existing author nameplate stays outside it. */
export function CrossThreadLetter({
  sourceThreadId,
  sourceInvocationId,
  senderCatId,
  content,
  targetCats,
  mentionsUser,
  getCatById,
  children,
}: Props) {
  const t = useShellCopy(crossThreadLetterCopy);
  const source = useCrossThreadLetterSource(sourceThreadId);
  const recipients = crossThreadLetterRecipients(content, targetCats, mentionsUser);
  const title = source.deleted
    ? t.deleted
    : source.title === undefined
      ? t.titleUnreadable
      : source.title || t.untitled;
  return (
    <section
      data-cross-thread-letter
      className="w-full min-w-0 overflow-hidden rounded-[10px] border"
      style={{ backgroundColor: 'var(--shell-paper)', borderColor: 'var(--shell-hairline)', color: 'var(--shell-ink)' }}
    >
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 text-compact"
        style={{ backgroundColor: 'var(--shell-frame)', borderColor: 'var(--shell-hairline)' }}
      >
        <span className="inline-flex shrink-0 items-center gap-1.5 font-semibold">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
            <rect x="1" y="2.5" width="14" height="11" rx="1.5" />
            <path d="m1 3 7 5 7-5" />
          </svg>
          {t.letter}
        </span>
        <span aria-hidden="true" style={{ color: 'var(--shell-muted)' }}>
          ·
        </span>
        <span className="min-w-0 max-w-full shrink truncate" title={`${title} · ${sourceThreadId}`}>
          {t.from(title)}
        </span>
        {recipients.length > 0 && (
          <span data-letter-recipients className="flex min-w-0 flex-wrap items-center gap-1">
            <span aria-hidden="true" style={{ color: 'var(--shell-muted)' }}>
              →
            </span>
            {recipients.map((id) => {
              const human = id === '__co-creator__';
              const cat = getCatById(id);
              return (
                <span
                  key={id}
                  data-letter-recipient={id}
                  className="max-w-full truncate rounded px-1.5 py-0.5 font-semibold"
                  title={id}
                  style={
                    human
                      ? { backgroundColor: 'var(--shell-primary)', color: 'var(--shell-primary-on)' }
                      : cat
                        ? { backgroundColor: catColorVar(id, 'surface'), color: catColorVar(id, 'text') }
                        : { backgroundColor: 'var(--shell-selected)', color: 'var(--shell-body)' }
                  }
                >
                  {human ? t.you : cat ? `@${cat.nickname || formatCatDisplayName(cat)}` : `@${id}`}
                </span>
              );
            })}
          </span>
        )}
        {!source.deleted && (
          <a
            href={`/thread/${sourceThreadId}`}
            title={sourceThreadId}
            className="ml-auto shrink-0 rounded text-cafe-muted hover:text-cafe-primary shell-focusable"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (sourceInvocationId)
                setPendingCrossPostScroll({ threadId: sourceThreadId, sourceInvocationId, senderCatId });
              pushThreadRouteWithHistory(sourceThreadId, typeof window !== 'undefined' ? window : undefined);
            }}
          >
            {t.goToSource}
          </a>
        )}
      </div>
      <div className="min-w-0 px-3 py-3">{children}</div>
    </section>
  );
}
