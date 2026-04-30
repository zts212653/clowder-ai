'use client';

import Link from 'next/link';
import React, { useState } from 'react';
import { anchorToHref, type RecallEvent, useRecallEvents } from '@/hooks/useRecallEvents';
import { ExpandableText } from '../ExpandableText';

function RecallCard({ event }: { event: RecallEvent }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg bg-[var(--console-card-bg)] p-2.5">
      <button type="button" onClick={() => setExpanded(!expanded)} className="flex w-full items-center gap-2 text-left">
        <span className="text-xs text-cafe-secondary">{expanded ? '\u25BE' : '\u25B8'}</span>
        <span className="flex-1 text-sm font-medium text-cafe-black truncate" title={event.query}>
          {event.query}
        </span>
        {event.resultCount != null && (
          <span className="rounded bg-[var(--console-hover-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-cafe-secondary">
            {event.resultCount} hits
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-2 space-y-1 border-t border-[var(--console-border-soft)] pt-2 text-xs text-cafe-secondary">
          {event.mode && <div>Mode: {event.mode}</div>}
          {event.scope && <div>Scope: {event.scope}</div>}
          <div>Time: {new Date(event.timestamp).toLocaleTimeString()}</div>
          {event.results && event.results.length > 0 && (
            <div className="mt-1.5 space-y-1.5">
              {event.results.map((r, i) => (
                <div
                  key={`${event.id}-r${i}`}
                  className="rounded border border-[var(--console-border-soft)] bg-cafe-surface p-1.5"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    {r.sourceType && (
                      <span className="rounded bg-[var(--console-hover-bg)]/60 px-1 py-0.5 text-[9px] font-semibold text-cafe-secondary">
                        {r.sourceType}
                      </span>
                    )}
                    <ExpandableText text={r.title} clampClass="truncate" className="font-medium text-cafe-black" />
                    {r.confidence && (
                      <span className="ml-auto text-[9px] text-cafe-secondary/70">[{r.confidence}]</span>
                    )}
                  </div>
                  {r.snippet && (
                    <ExpandableText
                      text={r.snippet}
                      as="p"
                      clampClass="line-clamp-2"
                      className="mt-0.5 text-[10px] text-cafe-secondary/80"
                    />
                  )}
                  {anchorToHref(r.anchor) && (
                    <Link
                      href={anchorToHref(r.anchor)!}
                      className="mt-0.5 flex items-center gap-1 text-[9px] font-mono text-cafe-secondary/70 hover:text-cafe-secondary hover:underline"
                      title={`追溯源头: ${r.anchor}`}
                    >
                      <span aria-hidden>&#x2197;</span>
                      <span className="truncate">{r.anchor}</span>
                    </Link>
                  )}
                </div>
              ))}
            </div>
          )}
          {event.results &&
            event.results.length > 0 &&
            event.resultCount != null &&
            event.resultCount > event.results.length && (
              <div className="mt-1 text-[10px] text-cafe-secondary/60">
                还有 {event.resultCount - event.results.length} 条结果未显示
              </div>
            )}
        </div>
      )}
    </div>
  );
}

export function RecallFeed() {
  const events = useRecallEvents();

  if (events.length === 0) {
    return (
      <div data-testid="recall-feed" className="p-3">
        <p className="text-xs text-cafe-secondary">
          猫猫还没有使用记忆搜索。当猫调用 search_evidence 时，这里会实时显示。
        </p>
      </div>
    );
  }

  return (
    <div data-testid="recall-feed" className="space-y-2 p-3">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-conn-emerald-text" />
        <span className="text-xs font-semibold text-cafe-black">LIVE</span>
        <span className="text-xs text-cafe-secondary">{events.length} recall(s)</span>
      </div>
      {events.map((evt) => (
        <RecallCard key={evt.id} event={evt} />
      ))}
    </div>
  );
}
