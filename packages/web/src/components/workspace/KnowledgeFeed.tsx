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
  const [activeTab, setActiveTab] = useState<FeedTab>('review');
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
      <div className="flex-1 flex items-center justify-center text-cocreator-dark/40 text-xs">
        Loading knowledge feed...
      </div>
    );
  }

  const tabs: Array<{ key: FeedTab; label: string; count?: number }> = [
    { key: 'review', label: '待确认', count: data?.needsReview.length },
    { key: 'settled', label: '已沉淀', count: data?.settled.length },
    { key: 'frequent', label: '高频' },
    { key: 'upgrade', label: '升级' },
  ];

  const currentItems =
    activeTab === 'review' ? (data?.needsReview ?? []) : activeTab === 'settled' ? (data?.settled ?? []) : []; // 高频 + 升级 tabs: data source not yet implemented

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tabs */}
      <div className="flex border-b border-cocreator-light/40">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
              activeTab === tab.key
                ? 'text-cocreator-primary border-b-2 border-cocreator-primary'
                : 'text-cocreator-dark/40 hover:text-cocreator-dark/60'
            }`}
          >
            {tab.label}
            {tab.count != null && tab.count > 0 && (
              <span
                className={`text-[9px] rounded-full px-1.5 py-0.5 ${
                  activeTab === tab.key
                    ? 'bg-cocreator-primary text-white'
                    : 'bg-cocreator-light/60 text-cocreator-dark/50'
                }`}
              >
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Feed items */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
        {currentItems.length === 0 ? (
          <div className="text-center text-cocreator-dark/40 text-xs py-8">
            {activeTab === 'review'
              ? '没有待确认的知识'
              : activeTab === 'frequent'
                ? '高频命中统计即将上线'
                : activeTab === 'upgrade'
                  ? '值得升级的知识即将上线'
                  : '暂无数据'}
          </div>
        ) : (
          currentItems.map((marker) => (
            <KnowledgeCard
              key={marker.id}
              marker={marker}
              tab={activeTab}
              onApprove={handleApprove}
              onReject={handleReject}
              onUndo={handleUndo}
            />
          ))
        )}
      </div>

      {/* Stats bar */}
      {data?.stats && (
        <div className="flex items-center justify-center gap-3 px-3 py-1.5 border-t border-cocreator-light/40 bg-cocreator-bg/30">
          <span className="text-[10px] font-semibold text-blue-600">{data.stats.decisions} decisions</span>
          <span className="text-[10px] font-semibold text-amber-600">{data.stats.lessons} lessons</span>
          <span className="text-[10px] font-semibold text-green-600">{data.stats.methods} methods</span>
        </div>
      )}
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
    decision: { bg: 'bg-blue-50', text: 'text-blue-700' },
    lesson: { bg: 'bg-amber-50', text: 'text-amber-700' },
    method: { bg: 'bg-green-50', text: 'text-green-700' },
  };
  const colors = kindColors[kind] ?? kindColors.lesson!;

  return (
    <div className="bg-white rounded-lg border border-cocreator-light/60 p-2.5 space-y-1.5">
      {/* Top row: kind badge + status */}
      <div className="flex items-center justify-between">
        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${colors.bg} ${colors.text}`}>
          {kind}
        </span>
        {tab === 'settled' && (
          <span className="text-[9px] font-medium text-green-600 bg-green-50 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
            <span>&#10003;</span> 已沉淀
          </span>
        )}
      </div>

      {/* Title */}
      <div className="text-xs font-semibold text-cafe-black leading-snug">{title}</div>

      {/* Source */}
      <div className="text-[10px] text-cocreator-dark/40">{marker.source}</div>

      {/* Actions */}
      {tab === 'review' && (
        <div className="flex items-center justify-end gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={() => onApprove(marker.id)}
            className="text-[10px] font-semibold text-white bg-cocreator-primary rounded px-2 py-1 hover:opacity-90 transition-opacity"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onReject(marker.id)}
            className="text-[10px] font-medium text-cocreator-dark/50 hover:text-cocreator-dark/80 transition-colors px-1.5 py-1"
          >
            Dismiss
          </button>
        </div>
      )}
      {tab === 'settled' && (
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => onUndo(marker.id)}
            className="text-[10px] font-medium text-cocreator-primary hover:underline"
          >
            撤回
          </button>
        </div>
      )}
    </div>
  );
}
