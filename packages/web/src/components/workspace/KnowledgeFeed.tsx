'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface Marker {
  id: string;
  content: string;
  source: string;
  status: string;
  targetKind?: string;
  createdAt: string;
}

interface FeedData {
  needsReview: Marker[];
  settled: Marker[];
  rejected: Marker[];
  stats: { decisions: number; lessons: number; methods: number; total: number };
}

type FeedTab = 'review' | 'settled' | 'frequent' | 'upgrade';

/**
 * Phase H: Knowledge Emergence Feed component.
 * Displays inside Workspace panel when "知识" mode is active.
 */
export function KnowledgeFeed() {
  const [data, setData] = useState<FeedData | null>(null);
  const [loading, setLoading] = useState(true);
  // pendingCount reserved for badge display in mode switcher
  const [, setPendingCount] = useState(0);

  const fetchFeed = useCallback(async () => {
    try {
      const res = await apiFetch('/api/knowledge/feed');
      if (res.ok) {
        const json = await res.json();
        setData(json);
        setPendingCount(json.needsReview?.length ?? 0);
      }
    } catch {
      // fail-open
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFeed();
    // Refresh every 60s
    const interval = setInterval(fetchFeed, 60000);
    return () => clearInterval(interval);
  }, [fetchFeed]);

  const handleApprove = useCallback(
    async (markerId: string) => {
      try {
        await apiFetch('/api/knowledge/approve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ markerId }),
        });
        fetchFeed();
      } catch {
        // fail-open
      }
    },
    [fetchFeed],
  );

  const handleReject = useCallback(
    async (markerId: string) => {
      try {
        await apiFetch('/api/knowledge/reject', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ markerId }),
        });
        fetchFeed();
      } catch {
        // fail-open
      }
    },
    [fetchFeed],
  );

  const handleUndo = useCallback(
    async (markerId: string) => {
      try {
        await apiFetch('/api/knowledge/undo', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ markerId }),
        });
        fetchFeed();
      } catch {
        // fail-open
      }
    },
    [fetchFeed],
  );

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-cafe-muted text-xs">Loading knowledge feed...</div>
    );
  }

  const allItems = [...(data?.needsReview ?? []), ...(data?.settled ?? [])];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto space-y-2">
        {allItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="mb-3 h-10 w-10 text-cafe-muted opacity-40"
            >
              <path
                d="M12 2a7 7 0 0 1 7 7c0 2.4-1.2 4.5-3 5.7V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.3C6.2 13.5 5 11.4 5 9a7 7 0 0 1 7-7Z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M9 21h6M10 17v1M14 17v1" strokeLinecap="round" />
            </svg>
            <p className="text-[14px] font-semibold text-cafe">暂无涌现知识</p>
            <p className="mt-1 text-xs text-cafe-muted">对话过程中产生的知识将自动出现在这里</p>
          </div>
        ) : (
          allItems.map((marker) => (
            <KnowledgeCard
              key={marker.id}
              marker={marker}
              tab={marker.status === 'settled' ? 'settled' : 'review'}
              onApprove={handleApprove}
              onReject={handleReject}
              onUndo={handleUndo}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** Single knowledge card */
function KnowledgeCard({
  marker,
  tab,
  onApprove,
  onReject,
  onUndo,
}: {
  marker: Marker;
  tab: FeedTab;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onUndo: (id: string) => void;
}) {
  // Parse kind from content: "[decision] title: claim"
  const kindMatch = marker.content.match(/^\[(decision|lesson|method)\]\s*/i);
  const kind = kindMatch?.[1]?.toLowerCase() ?? 'lesson';
  const title = marker.content.replace(/^\[(decision|lesson|method)\]\s*/i, '');

  const kindColors: Record<string, { bg: string; text: string }> = {
    decision: { bg: 'bg-[var(--color-cafe-accent)]/10', text: 'text-[var(--color-cafe-accent)]' },
    lesson: { bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text' },
    method: { bg: 'bg-conn-emerald-bg', text: 'text-conn-emerald-text' },
  };
  const colors = kindColors[kind] ?? kindColors.lesson!;

  const iconName = kind === 'decision' ? '✦' : kind === 'method' ? '⚙' : '📖';

  return (
    <div className="flex items-center gap-3 rounded-[14px] bg-[var(--console-card-bg)] px-3 py-3.5 shadow-[0_8px_22px_rgba(43,33,26,0.04)]">
      <span className="shrink-0 text-base text-cafe-secondary">{iconName}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-bold leading-[1.35] text-cafe">{title}</p>
        <p className="mt-1 text-xs text-cafe-secondary">{marker.source}</p>
      </div>
      <span className={`shrink-0 rounded-md px-2 py-[3px] text-[11px] font-semibold ${colors.bg} ${colors.text}`}>
        {kind}
      </span>
      {tab === 'review' && (
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={() => onApprove(marker.id)}
            className="rounded-md bg-cafe-accent px-2 py-1 text-[10px] font-semibold text-[var(--cafe-surface)] hover:opacity-90"
          >
            ✓
          </button>
          <button
            type="button"
            onClick={() => onReject(marker.id)}
            className="rounded-md px-1.5 py-1 text-[10px] text-cafe-muted hover:text-cafe-secondary"
          >
            ✕
          </button>
        </div>
      )}
      {tab === 'settled' && (
        <button
          type="button"
          onClick={() => onUndo(marker.id)}
          className="shrink-0 text-[10px] font-medium text-cafe-accent hover:underline"
        >
          撤回
        </button>
      )}
    </div>
  );
}
