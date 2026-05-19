'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface Marker {
  id: string;
  content: string;
  source: string;
  status: string;
  targetKind?: string;
  sourceCollectionId?: string;
  sourceSensitivity?: string;
  createdAt: string;
}

interface CollectionOption {
  id: string;
  displayName: string;
  sensitivity: string;
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
  const [collections, setCollections] = useState<CollectionOption[]>([]);
  const [approveErrors, setApproveErrors] = useState<Record<string, string>>({});

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
    const interval = setInterval(fetchFeed, 60000);
    return () => clearInterval(interval);
  }, [fetchFeed]);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/library/catalog');
        if (res.ok) {
          const json = await res.json();
          const active = (json.collections ?? [])
            .filter((c: { manifest: { status?: string } }) => (c.manifest.status ?? 'active') === 'active')
            .map((c: { manifest: CollectionOption }) => ({
              id: c.manifest.id,
              displayName: c.manifest.displayName,
              sensitivity: c.manifest.sensitivity,
            }));
          setCollections(active);
        }
      } catch {
        // fail-open
      }
    })();
  }, []);

  const handleApprove = useCallback(
    async (markerId: string, targetCollectionId?: string) => {
      try {
        setApproveErrors((prev) => {
          const next = { ...prev };
          delete next[markerId];
          return next;
        });

        const payload: Record<string, unknown> = { markerId };
        if (targetCollectionId) payload.targetCollectionId = targetCollectionId;

        const res = await apiFetch('/api/knowledge/approve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const err = await res.json();
          if (res.status === 400 && typeof err.error === 'string' && err.error.includes('visibility-widening')) {
            const confirmed = globalThis.confirm(err.detail ?? 'This action widens visibility. Proceed?');
            if (!confirmed) return;

            const retryRes = await apiFetch('/api/knowledge/approve', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...payload, confirmVisibilityWidening: true }),
            });
            if (!retryRes.ok) {
              const retryErr = await retryRes.json();
              setApproveErrors((prev) => ({ ...prev, [markerId]: retryErr.error ?? 'Approve failed' }));
              return;
            }
          } else {
            setApproveErrors((prev) => ({ ...prev, [markerId]: err.error ?? 'Approve failed' }));
            return;
          }
        }

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
      <div className="flex-1 flex items-center justify-center text-cafe-interactive/40 text-xs">
        Loading knowledge feed...
      </div>
    );
  }

  const tabs: Array<{ key: FeedTab; label: string; count?: number }> = [
    { key: 'review', label: '待确认', count: data?.needsReview.length },
    { key: 'settled', label: '已确认', count: data?.settled.length },
    { key: 'frequent', label: '高频' },
    { key: 'upgrade', label: '升级' },
  ];

  const currentItems =
    activeTab === 'review' ? (data?.needsReview ?? []) : activeTab === 'settled' ? (data?.settled ?? []) : []; // 高频 + 升级 tabs: data source not yet implemented

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tabs */}
      <div className="flex border-b border-cafe-subtle/40">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
              activeTab === tab.key
                ? 'text-cafe-accent border-b-2 border-cafe-accent'
                : 'text-cafe-interactive/40 hover:text-cafe-interactive/60'
            }`}
          >
            {tab.label}
            {tab.count != null && tab.count > 0 && (
              <span
                className={`text-[10px] rounded-full px-1.5 py-0.5 ${
                  activeTab === tab.key
                    ? 'bg-cafe-accent text-white'
                    : 'bg-cafe-surface-sunken/60 text-cafe-interactive/50'
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
          <div className="text-center text-cafe-interactive/40 text-xs py-8">
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
              collections={collections}
              error={approveErrors[marker.id]}
              onApprove={handleApprove}
              onReject={handleReject}
              onUndo={handleUndo}
            />
          ))
        )}
      </div>

      {/* Stats bar */}
      {data?.stats && (
        <div className="flex items-center justify-center gap-3 px-3 py-1.5 border-t border-cafe-subtle/40 bg-cafe-surface/30">
          <span className="text-[10px] font-semibold text-blue-600">{data.stats.decisions} decisions</span>
          <span className="text-[10px] font-semibold text-conn-amber-text">{data.stats.lessons} lessons</span>
          <span className="text-[10px] font-semibold text-conn-green-text">{data.stats.methods} methods</span>
        </div>
      )}
    </div>
  );
}

/** Single knowledge card */
function KnowledgeCard({
  marker,
  tab,
  collections,
  error,
  onApprove,
  onReject,
  onUndo,
}: {
  marker: Marker;
  tab: FeedTab;
  collections: CollectionOption[];
  error?: string;
  onApprove: (id: string, collectionId?: string) => void;
  onReject: (id: string) => void;
  onUndo: (id: string) => void;
}) {
  const [selectedCollection, setSelectedCollection] = useState('');
  const isPrivateSource = marker.sourceSensitivity === 'private' || marker.sourceSensitivity === 'restricted';
  // Parse kind from content: "[decision] title: claim"
  const kindMatch = marker.content.match(/^\[(decision|lesson|method)\]\s*/i);
  const kind = kindMatch?.[1]?.toLowerCase() ?? 'lesson';
  const title = marker.content.replace(/^\[(decision|lesson|method)\]\s*/i, '');

  const kindColors: Record<string, { bg: string; text: string }> = {
    decision: { bg: 'bg-conn-blue-bg', text: 'text-blue-700' },
    lesson: { bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text' },
    method: { bg: 'bg-conn-green-bg', text: 'text-conn-green-text' },
  };
  const colors = kindColors[kind] ?? kindColors.lesson!;

  return (
    <div className="bg-cafe-surface rounded-lg border border-cafe-subtle/60 p-2.5 space-y-1.5">
      {/* Top row: kind badge + status */}
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${colors.bg} ${colors.text}`}>
          {kind}
        </span>
        {tab === 'settled' && (
          <span className="text-[10px] font-medium text-conn-green-text bg-conn-green-bg px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
            <span>&#10003;</span> 已确认
          </span>
        )}
      </div>

      {/* Title */}
      <div className="text-xs font-semibold text-cafe-black leading-snug">{title}</div>

      {/* Source */}
      <div className="text-[10px] text-cafe-interactive/40">{marker.source}</div>

      {/* Actions */}
      {tab === 'review' && (
        <div className="space-y-1.5 pt-0.5">
          {collections.length > 0 && (
            <select
              value={selectedCollection}
              onChange={(e) => setSelectedCollection(e.target.value)}
              className="w-full text-[10px] bg-cafe-surface-sunken/40 border border-cafe-subtle/60 rounded px-1.5 py-1 text-cafe-interactive/70"
            >
              <option value="" disabled={isPrivateSource}>
                自动选择
              </option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName} ({c.sensitivity})
                </option>
              ))}
            </select>
          )}
          {error && <div className="text-[10px] text-conn-red-text bg-conn-red-bg/30 rounded px-1.5 py-1">{error}</div>}
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => onApprove(marker.id, selectedCollection || undefined)}
              className="text-[10px] font-semibold text-white bg-cafe-accent rounded px-2 py-1 hover:opacity-90 transition-opacity"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => onReject(marker.id)}
              className="text-[10px] font-medium text-cafe-interactive/50 hover:text-cafe-interactive/80 transition-colors px-1.5 py-1"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {tab === 'settled' && (
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => onUndo(marker.id)}
            className="text-[10px] font-medium text-cafe-accent hover:underline"
          >
            撤回
          </button>
        </div>
      )}
    </div>
  );
}
