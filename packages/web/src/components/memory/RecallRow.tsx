'use client';
import Link from 'next/link';
import { useState } from 'react';
import { openExactPlace } from '@/components/shell/mailbox/open-exact-place';
import { useWorkspaceChatReveal } from '@/components/workbench/WorkspaceChatReveal';
import { recallDeliveryLabel, recallResultHref, recallResultTitle, recallTypeLabel } from '@/hooks/recall-display';
import type { RecallKind } from '@/hooks/recall-feed-model';
import { recallEventDisplayTitle, recallEventResultLabel, recallKind } from '@/hooks/recall-feed-model';
import type { RecallEvent } from '@/hooks/recall-types';

export function RecallIcon({ kind }: { kind: RecallKind }) {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'search' ? (
        <>
          <circle cx="10" cy="10" r="6" />
          <path d="m15 15 5 5" />
        </>
      ) : kind === 'graph' ? (
        <>
          <circle cx="6" cy="12" r="2" />
          <circle cx="18" cy="5" r="2" />
          <circle cx="18" cy="19" r="2" />
          <path d="m8 11 8-5M8 13l8 5" />
        </>
      ) : (
        <>
          <path d="M4 5h6l2 2 2-2h6v14h-6l-2 2-2-2H4zM12 7v14" />
        </>
      )}
    </svg>
  );
}
export function RecallCard({
  event,
  allowDeliveryExpansion = true,
}: {
  event: RecallEvent;
  allowDeliveryExpansion?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const revealChat = useWorkspaceChatReveal();
  const title = recallEventDisplayTitle(event);
  const results = event.results ?? [];
  const kind = recallKind(event);
  const expandable = kind !== 'delivery' || allowDeliveryExpansion;
  const summary = (
    <>
      <span className="mt-1 text-cafe-secondary" title={{ search: '检索', graph: '关系查询', delivery: '递送' }[kind]}>
        <RecallIcon kind={kind} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-sm text-cafe-black ${expanded ? 'break-words' : 'truncate'}`} title={title}>
          {title}
        </span>
        <span className="mt-1 block text-compact text-cafe-secondary">
          {recallDeliveryLabel(event) && `${recallDeliveryLabel(event)} · `}
          {recallEventResultLabel(event)}
        </span>
      </span>
    </>
  );
  return (
    <div data-recall-event-id={event.id} className="min-w-0">
      {expandable ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-cafe-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--cafe-accent)]"
        >
          {summary}
        </button>
      ) : (
        <div className="flex w-full items-start gap-3 rounded-md px-2 py-2">{summary}</div>
      )}
      {expandable && expanded && (
        <div className="ml-8 mt-1 rounded-lg border border-cafe-border-subtle bg-cafe-surface-canvas px-3 py-1 text-compact">
          {!results.length && (
            <p className="py-3 text-cafe-secondary">{event.resultCount === 0 ? '没有命中' : '命中详情没有记录下来'}</p>
          )}
          {results.map((item, index) => (
            <div
              key={`${item.anchor ?? item.title}:${index}`}
              className="border-b border-cafe-border-subtle py-3 last:border-b-0"
            >
              <div className="flex items-start gap-2">
                <span className="shrink-0 rounded bg-cafe-surface px-2 py-0.5 text-xs text-cafe-secondary">
                  {recallTypeLabel(item.sourceType)}
                </span>
                <span className="min-w-0 flex-1 break-words text-sm text-cafe-black">{recallResultTitle(item)}</span>
              </div>
              {item.snippet && <p className="mt-2 break-words text-compact text-cafe-secondary">{item.snippet}</p>}
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-cafe-secondary">
                  {event.cueStatus ? recallEventResultLabel(event) : item.consumed ? '之后读了' : '之后没看到读取'}
                </span>
                {recallResultHref(item) && (
                  <Link
                    href={recallResultHref(item)!}
                    onClick={(event) => {
                      if (
                        event.defaultPrevented ||
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      const source = /^\/thread\/([A-Za-z0-9_-]{1,200})\?message=([A-Za-z0-9_-]{1,200})$/.exec(
                        recallResultHref(item) ?? '',
                      );
                      if (!source) return;
                      event.preventDefault();
                      // The Chat host owns panel visibility (it re-opens a 'workspace' panel on its own);
                      // ask it to reveal this conversation so the exact message is not left under the overlay.
                      revealChat?.(source[1]);
                      openExactPlace(`message:${source[1]}:${source[2]}`, window.location.pathname);
                    }}
                    className="text-cafe-accent hover:underline"
                  >
                    打开<span className="sr-only"> {recallResultTitle(item)}</span>
                  </Link>
                )}
              </div>
            </div>
          ))}
          {event.resultCount != null && event.resultCount > results.length && (
            <p className="py-3 text-xs text-cafe-secondary">
              另外 {event.resultCount - results.length} 条的详情没有记录下来
            </p>
          )}
        </div>
      )}
    </div>
  );
}
