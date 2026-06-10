'use client';

import type { StoredEventMemory } from '@cat-cafe/shared';
// biome-ignore lint/correctness/noUnusedImports: React needed for JSX in vitest env
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { handleTeleportEvent } from '@/hooks/useTeleport';
import { useChatStore } from '@/stores/chatStore';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { Chip, LoadMoreButton, TimelineRow } from './event-timeline-cards';
import { loadEventsPage, loadTimelineData } from './event-timeline-data';
import { type MeaningMap, TRIGGER_LABEL } from './event-timeline-format';
import { buildTimelineModel, magicWordCounts } from './event-timeline-model';

export function EventTimeline() {
  const [events, setEvents] = useState<StoredEventMemory[]>([]);
  const [meanings, setMeanings] = useState<MeaningMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [activeWord, setActiveWord] = useState<string | null>(null);
  const [activeTrigger, setActiveTrigger] = useState<string | null>(null);
  const [showFolded, setShowFolded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    loadTimelineData()
      .then(({ events: ev, meanings: mw, hasMore: more }) => {
        if (cancelled) return;
        setEvents(ev);
        setMeanings(mw);
        setHasMore(more);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onTeleport = useCallback((threadId: string, messageId: string) => {
    handleTeleportEvent({ threadId, messageId }, useChatStore.getState().currentThreadId, {
      pushThreadRoute: (tid) => pushThreadRouteWithHistory(tid, window),
      scrollToMessage,
    });
  }, []);

  // Append the next older page (cloud-review P2: a full-corpus backfill exceeds one page,
  // so paginate by offset instead of hiding everything past the first 200).
  const loadMore = useCallback(() => {
    setLoadingMore(true);
    loadEventsPage(events.length)
      .then((page) => {
        setEvents((prev) => [...prev, ...page.events]);
        setHasMore(page.hasMore);
      })
      .catch(() => {
        /* keep the button visible so the user can retry */
      })
      .finally(() => setLoadingMore(false));
  }, [events.length]);

  const counts = useMemo(() => magicWordCounts(events), [events]);
  const triggers = useMemo(() => [...new Set(events.map((e) => e.trigger))], [events]);
  const model = useMemo(
    () => buildTimelineModel(events, { magicWord: activeWord ?? undefined, trigger: activeTrigger ?? undefined }),
    [events, activeWord, activeTrigger],
  );
  const activeMeaning = activeWord ? meanings[activeWord] : null;

  if (loading) return <div className="px-5 py-4 text-xs text-cafe-muted">加载拉闸记录…</div>;
  if (error) return <div className="px-5 py-4 text-xs text-[var(--semantic-critical)]">加载失败，请稍后重试</div>;

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: 'var(--cafe-surface)' }}>
      {/* Header */}
      <div className="px-5 pt-4 pb-3 border-b border-cafe-subtle" style={{ background: 'var(--accent-50)' }}>
        <div className="flex items-center gap-2">
          <svg
            className="text-cafe-accent"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          <div>
            <div className="text-base font-bold text-cafe-black leading-tight">拉闸记录</div>
            <div className="text-micro text-cafe-muted tracking-wide">猫的认知地图 · 每一次转折都有坐标</div>
          </div>
        </div>
      </div>

      {/* Filter chips */}
      <div className="px-5 pt-3 pb-1 flex flex-wrap gap-1.5">
        <Chip label="全部" count={events.length} active={activeWord === null} onClick={() => setActiveWord(null)} />
        {counts.map((c) => (
          <Chip
            key={c.word}
            label={c.word}
            count={c.count}
            active={activeWord === c.word}
            onClick={() => setActiveWord(activeWord === c.word ? null : c.word)}
          />
        ))}
      </div>

      {/* Event-type (trigger) filter — AC-A3 事件类型 */}
      {triggers.length > 0 && (
        <div className="px-5 pt-1.5 pb-1 flex flex-wrap items-center gap-1.5">
          <span className="text-micro font-semibold uppercase tracking-wide text-cafe-muted mr-1">事件类型</span>
          <Chip
            label="全部"
            count={events.length}
            active={activeTrigger === null}
            onClick={() => setActiveTrigger(null)}
          />
          {triggers.map((t) => (
            <Chip
              key={t}
              label={TRIGGER_LABEL[t] ?? t}
              count={events.filter((e) => e.trigger === t).length}
              active={activeTrigger === t}
              onClick={() => setActiveTrigger(activeTrigger === t ? null : t)}
            />
          ))}
          {!triggers.includes('cat_brake') && (
            <span className="text-micro text-cafe-muted px-1.5 py-1 opacity-60">猫自拉闸 · Phase B</span>
          )}
        </div>
      )}

      {/* Meaning strip (AC-A5: read from L0) */}
      {activeWord && activeMeaning && (
        <div
          className="mx-5 mt-2 rounded-lg px-3 py-2 text-xs text-cafe-secondary flex gap-2 items-baseline"
          style={{ background: 'var(--accent-50)', border: '1px solid oklch(0.85 0.06 50)' }}
        >
          <span className="font-bold text-cafe-accent whitespace-nowrap">{activeWord}</span>
          <span>
            {activeMeaning.meaning} → {activeMeaning.action}
            <i className="text-cafe-muted">（含义读自 L0 家规）</i>
          </span>
        </div>
      )}

      {/* Timeline */}
      <div className="relative px-5 py-3">
        <div className="absolute left-[26px] top-3 bottom-3 w-px bg-cafe-subtle" aria-hidden="true" />
        {model.total === 0 ? (
          <div className="py-8 text-center text-xs text-cafe-muted">
            还没有{activeWord ? `「${activeWord}」` : ''}拉闸事件
          </div>
        ) : (
          <div className="space-y-3">
            {model.hero && <TimelineRow event={model.hero} variant="hero" onTeleport={onTeleport} />}
            {model.groups.map((group) => (
              <div key={group.dayLabel} className="space-y-3">
                <div className="flex items-center gap-2 pl-1 text-micro text-cafe-muted">
                  <span className="h-px flex-1 bg-cafe-subtle" /> {group.dayLabel}{' '}
                  <span className="h-px flex-1 bg-cafe-subtle" />
                </div>
                {group.events.map((event) => (
                  <TimelineRow key={event.eventId} event={event} variant="compact" onTeleport={onTeleport} />
                ))}
              </div>
            ))}
            {model.folded.length > 0 && (
              <div className="pl-9">
                <button
                  type="button"
                  onClick={() => setShowFolded((s) => !s)}
                  className="w-full flex items-center gap-2 rounded-lg border border-dashed border-cafe-border bg-cafe-surface-sunken/60 px-3 py-2 text-xs text-cafe-muted hover:bg-cafe-surface-sunken"
                >
                  <span className={`transition-transform ${showFolded ? 'rotate-90' : ''}`}>›</span>
                  <b className="text-cafe-secondary font-semibold">{model.folded.length} 条低置信事件</b>
                  <span className="ml-auto text-micro">讨论 / 列词表上下文 — 非拉闸</span>
                </button>
                {showFolded && (
                  <div className="mt-3 space-y-3 opacity-90">
                    {model.folded.map((event) => (
                      <TimelineRow key={event.eventId} event={event} variant="compact" onTeleport={onTeleport} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <LoadMoreButton hasMore={hasMore} loading={loadingMore} onClick={loadMore} />
    </div>
  );
}
