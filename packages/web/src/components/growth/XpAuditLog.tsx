'use client';

/**
 * F157 AC-A5: Footfall Audit Log — shows recent footfall (足迹点) events for a cat.
 * Renders as an expandable section within the profile card.
 */

import type { GrowthDimension, XpEvent } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

const DIM_LABELS: Record<GrowthDimension, string> = {
  architecture: '架构力',
  review: '审查力',
  aesthetics: '审美力',
  execution: '执行力',
  collaboration: '协作力',
  insight: '洞察力',
};

const SOURCE_LABELS: Record<string, string> = {
  task_complete: '完成任务',
  session_seal: '会话封存',
  review_given: 'Review',
  review_received: '收到 Review',
  tool_use: '工具调用',
  mention_collab: '@协作',
  discussion: '讨论',
  pr_merged: 'PR 合并',
  bug_caught: '发现 Bug',
  design_feedback: '设计反馈',
  rich_block_create: '创建卡片',
  evidence_cite: '引用证据',
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
  /** When true, expand and fetch immediately (used inside detail modal). */
  defaultOpen?: boolean;
}

export function XpAuditLog({ catId, color = '#9B7EBD', defaultOpen = false }: Props) {
  const [events, setEvents] = useState<XpEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [expanded, setExpanded] = useState(defaultOpen);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setFetchError(false);
    let ok = false;
    try {
      const res = await apiFetch(`/api/journey/${catId}/events?limit=30`);
      if (res.ok) {
        const data = (await res.json()) as { events: XpEvent[] };
        setEvents(data.events);
        ok = true;
      } else {
        setFetchError(true);
      }
    } catch {
      setFetchError(true);
    } finally {
      setLoading(false);
      // Only mark as fetched on success — error state allows retry on re-expand
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
        <span>足迹记录</span>
        {events.length > 0 && <span className="text-cafe-muted">({events.length})</span>}
      </button>

      {expanded && (
        <div className="mt-2 max-h-48 overflow-y-auto">
          {loading ? (
            <div className="py-2 text-center text-xs text-cafe-muted">加载中...</div>
          ) : fetchError ? (
            <div className="py-2 text-center text-xs text-red-400">加载失败，请稍后重试</div>
          ) : events.length === 0 ? (
            <div className="py-2 text-center text-xs text-cafe-muted">暂无足迹记录</div>
          ) : (
            <div className="space-y-1">
              {events.map((ev, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-cafe-surface-elevated"
                >
                  <span className="font-medium" style={{ color }}>
                    +{ev.xp}
                  </span>
                  <span className="text-cafe-secondary">{DIM_LABELS[ev.dimension] ?? ev.dimension}</span>
                  <span className="flex-1 text-cafe-muted">{SOURCE_LABELS[ev.source] ?? ev.source}</span>
                  <span className="text-cafe-muted">{relativeTime(ev.timestamp)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
