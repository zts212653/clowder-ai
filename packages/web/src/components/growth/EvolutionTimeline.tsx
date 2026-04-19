'use client';

/**
 * F157 AC-E2: Evolution Timeline — milestone narrative events for a cat.
 * Displays level-ups, first dimensions, title/achievement unlocks in a
 * vertical timeline. Expandable section, lazy-loaded on first open.
 */

import type { EvolutionEvent, EvolutionEventType } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

/** Icon per event type — plain text emoji keeps bundle small. */
const TYPE_ICON: Record<EvolutionEventType, string> = {
  level_up: '\u2B06\uFE0F', // arrow up
  first_dim: '\u2728', // sparkles
  achievement_unlocked: '\uD83C\uDFC6', // trophy
  title_unlocked: '\uD83D\uDC51', // crown
  bond_milestone: '\uD83E\uDD1D', // handshake
};

const TYPE_LABEL: Record<EvolutionEventType, string> = {
  level_up: '升级',
  first_dim: '新维度',
  achievement_unlocked: '瞬间',
  title_unlocked: '称号',
  bond_milestone: '羁绊',
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  return `${Math.floor(diff / 86_400_000)}天前`;
}

interface Props {
  catId: string;
  color?: string;
}

export function EvolutionTimeline({ catId, color = '#9B7EBD' }: Props) {
  const [events, setEvents] = useState<EvolutionEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setFetchError(false);
    let ok = false;
    try {
      const res = await apiFetch(`/api/journey/${catId}/evolution?limit=30`);
      if (res.ok) {
        const data = (await res.json()) as { events: EvolutionEvent[] };
        setEvents(data.events);
        ok = true;
      } else {
        setFetchError(true);
      }
    } catch {
      setFetchError(true);
    } finally {
      setLoading(false);
      if (ok) setFetched(true);
    }
  }, [catId]);

  useEffect(() => {
    if (expanded && !fetched) fetchEvents();
  }, [expanded, fetched, fetchEvents]);

  return (
    <div className="mt-3 border-t border-cafe-surface-elevated pt-2">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 text-xs text-cafe-secondary transition-colors hover:text-cafe"
      >
        <span
          className="text-[10px]"
          style={{
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            display: 'inline-block',
            transition: 'transform 0.15s',
          }}
        >
          &#9654;
        </span>
        <span>成长里程碑</span>
        {events.length > 0 && <span className="text-cafe-muted">({events.length})</span>}
      </button>

      {expanded && (
        <div className="mt-2 max-h-56 overflow-y-auto">
          {loading ? (
            <div className="py-2 text-center text-xs text-cafe-muted">加载中...</div>
          ) : fetchError ? (
            <div className="py-2 text-center text-xs text-red-400">加载失败，请稍后重试</div>
          ) : events.length === 0 ? (
            <div className="py-2 text-center text-xs text-cafe-muted">暂无里程碑记录</div>
          ) : (
            <div className="relative ml-3 border-l-2 border-cafe-surface-elevated pl-4">
              {events.map((ev, i) => (
                <div key={i} className="relative pb-3 last:pb-0">
                  {/* Dot on the timeline line */}
                  <div
                    className="absolute -left-[21px] top-0.5 h-3 w-3 rounded-full border-2 border-cafe-surface"
                    style={{ backgroundColor: color }}
                  />
                  <div className="flex items-start gap-2">
                    <span className="text-sm leading-none">{TYPE_ICON[ev.type] ?? '\u2022'}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-cafe">{ev.narrative.zh}</p>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-cafe-muted">
                        <span className="rounded px-1 py-px" style={{ backgroundColor: `${color}18` }}>
                          {TYPE_LABEL[ev.type] ?? ev.type}
                        </span>
                        <span>{relativeTime(ev.timestamp)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
