'use client';

// biome-ignore lint/correctness/noUnusedImports: React needed for JSX in vitest environment
import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface AuditEvent {
  id: string;
  type: string;
  timestamp: number;
  threadId?: string;
  data: Record<string, unknown>;
}

export interface AuditEventsTabProps {
  threadId: string;
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

const TYPE_COLORS: Record<string, string> = {
  invocation_error: 'bg-red-100 text-red-700',
  phase_completed: 'bg-green-100 text-green-700',
  debate_winner: 'bg-blue-100 text-blue-700',
};

export function AuditEventsTab({ threadId }: AuditEventsTabProps) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await apiFetch(`/api/audit/thread/${threadId}`);
      if (!res.ok) {
        setError(true);
        return;
      }
      const data = (await res.json()) as { events: AuditEvent[] };
      setEvents(data.events);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  if (loading) {
    return <div className="text-xs text-cafe-muted py-2">加载中...</div>;
  }

  if (error) {
    return <div className="text-xs text-red-500 py-2">加载失败</div>;
  }

  if (events.length === 0) {
    return <div className="text-xs text-cafe-muted py-2">最近 7 天无审计事件</div>;
  }

  return (
    <div className="space-y-1 max-h-64 overflow-y-auto">
      {events.map((evt) => {
        const isExpanded = expandedId === evt.id;
        const colorClass = TYPE_COLORS[evt.type] ?? 'bg-cafe-surface-elevated text-cafe-secondary';
        return (
          <button
            type="button"
            key={evt.id}
            data-testid="audit-event-row"
            className="w-full text-left rounded border border-cafe-subtle px-2 py-1.5 cursor-pointer hover:bg-cafe-surface-elevated transition-colors"
            onClick={() => setExpandedId(isExpanded ? null : evt.id)}
          >
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colorClass}`}>{evt.type}</span>
              <span className="text-cafe-muted ml-auto">{timeAgo(evt.timestamp)}</span>
            </div>
            {isExpanded && (
              <pre className="mt-1.5 text-[10px] text-cafe-secondary bg-cafe-surface-elevated rounded p-1.5 overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(evt.data, null, 2)}
              </pre>
            )}
          </button>
        );
      })}
    </div>
  );
}
