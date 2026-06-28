'use client';

/**
 * F233 Phase C C3 — Feat 球权轨迹时间轴主面板（设计稿 §2 布局）。
 *
 * WorkspacePanel 的新 mode（`workspaceMode === 'trajectory'`）。
 * 顶部 feat picker（combobox）→ 选 feat → 垂直时间轴（三源收敛 + 13 kind 视觉 + 提包球高亮）。
 *
 * 数据源（opus-47 C2b 推中）：
 * - `GET /api/feat-trajectory/feats` → string[]
 * - `GET /api/feat-trajectory/:featId` → FeatTrajectoryProjection
 * API 未就绪时显示空/错误态；dev 自测走 `?trajMock=F188`（生产 build 被 tree-shake）。
 */

import type { FeatTrajectoryProjection } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { TrajectoryCard } from './TrajectoryCard';

function EmptyState({ loadingList, hasFeats }: { loadingList: boolean; hasFeats: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-12">
      <div className="text-4xl opacity-40 animate-pulse drop-shadow-[0_0_8px_rgba(168,85,247,0.4)]" aria-hidden>
        🐾
      </div>
      <p className="text-sm text-neutral-500 max-w-[220px] leading-relaxed">
        {loadingList
          ? '载入 Feat 列表中...'
          : hasFeats
            ? '请选择或输入 Feat 编号以载入轨迹流水账'
            : '暂无 Feat 轨迹数据'}
      </p>
    </div>
  );
}

function SourceCounts({ counts }: { counts: FeatTrajectoryProjection['countsBySource'] }) {
  const items: Array<[string, number]> = [
    ['event-stream', counts['event-stream'] ?? 0],
    ['git-ref', counts['git-ref-snapshot'] ?? 0],
    ['stitched', counts['historical-stitched'] ?? 0],
  ];
  const shown = items.filter(([, n]) => n > 0);
  if (shown.length === 0) return null;
  return (
    <span className="ml-auto flex items-center gap-2">
      {shown.map(([label, n]) => (
        <span key={label} className="font-mono text-neutral-600">
          {label}:{n}
        </span>
      ))}
    </span>
  );
}

export function TrajectoryPanel() {
  const setCurrentThread = useChatStore((s) => s.setCurrentThread);
  const [featIds, setFeatIds] = useState<string[]>([]);
  const [selectedFeat, setSelectedFeat] = useState<string | null>(null);
  const [projection, setProjection] = useState<FeatTrajectoryProjection | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingTraj, setLoadingTraj] = useState(false);
  const [query, setQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cloud round 5 P2 fix: monotonic request ID — when the user picks F188 then
  // quickly picks F233, the older F188 fetch may still resolve after the F233
  // selection. Guard each loadTrajectory call with a request id check before
  // committing state, so stale responses are dropped silently.
  const requestIdRef = useRef(0);

  // ── fetch feat 列表 ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/feat-trajectory/feats');
        if (res.ok) {
          const json = await res.json();
          const ids: string[] = Array.isArray(json) ? json : (json.feats ?? []);
          if (!cancelled) setFeatIds(ids);
        }
      } catch {
        /* fail-open — API 未就绪 */
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadTrajectory = useCallback(async (featId: string) => {
    // Cloud round 5 P2 fix: bump the request id BEFORE async work; later we
    // compare back to discard stale responses (user picked F188 → quickly
    // switched to F233 → F188 fetch arrives last and would overwrite F233).
    const reqId = ++requestIdRef.current;
    setSelectedFeat(featId);
    setPickerOpen(false);
    setQuery(featId);
    setLoadingTraj(true);
    setError(null);
    setProjection(null);
    try {
      const res = await apiFetch(`/api/feat-trajectory/${encodeURIComponent(featId)}`);
      // First async boundary: check after the network round-trip resolves.
      if (reqId !== requestIdRef.current) return;
      if (res.ok) {
        // 砚砚 final-SHA review P2: `await res.json()` is a SECOND async
        // boundary; user can switch/clear during body-parse → stale json
        // still overwrites. Re-check after json() resolves too.
        const json = await res.json();
        if (reqId !== requestIdRef.current) return;
        setProjection(json);
      } else {
        setError(`轨迹载入失败 (${res.status})`);
      }
    } catch {
      if (reqId !== requestIdRef.current) return;
      setError('轨迹载入失败（网络/服务未就绪）');
    } finally {
      // Only the latest request resets loading; otherwise the new in-flight
      // request would be falsely marked "done" by the stale one's finally.
      if (reqId === requestIdRef.current) {
        setLoadingTraj(false);
      }
    }
  }, []);

  // ── DEV-ONLY 自测注入：?trajMock=F188（生产 NODE_ENV gate + dynamic import → tree-shake）──
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' || typeof window === 'undefined') return;
    const mockFeat = new URLSearchParams(window.location.search).get('trajMock');
    if (!mockFeat) return;
    void import('./__fixtures__/trajectory-mock').then(({ MOCK_TRAJECTORIES, MOCK_FEAT_IDS }) => {
      setFeatIds(MOCK_FEAT_IDS);
      setLoadingList(false);
      const proj = MOCK_TRAJECTORIES[mockFeat];
      if (proj) {
        setSelectedFeat(mockFeat);
        setQuery(mockFeat);
        setProjection(proj);
        setLoadingTraj(false);
      }
    });
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || q === selectedFeat?.toLowerCase()) return featIds;
    return featIds.filter((f) => f.toLowerCase().includes(q));
  }, [featIds, query, selectedFeat]);

  const entries = projection?.entries ?? [];

  const handleJumpToThread = useCallback(
    (threadId: string) => {
      setCurrentThread(threadId);
    },
    [setCurrentThread],
  );

  return (
    <div className="flex flex-col h-full bg-[#0a0d14] text-neutral-200">
      {/* 顶部 feat picker */}
      <div className="px-3 py-2.5 border-b border-neutral-800 relative">
        <div className="flex items-center gap-1.5 bg-neutral-900/80 border border-neutral-700 rounded-lg px-2.5 py-1.5 focus-within:border-conn-purple-ring/60 transition-all">
          <svg
            className="w-3.5 h-3.5 text-neutral-500 flex-shrink-0"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M9.965 11.026a5 5 0 1 1 1.06-1.06l2.755 2.754a.75.75 0 1 1-1.06 1.06l-2.755-2.754ZM10.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z"
              clipRule="evenodd"
            />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPickerOpen(true);
            }}
            onFocus={() => setPickerOpen(true)}
            onBlur={() => setTimeout(() => setPickerOpen(false), 150)}
            placeholder="搜索并选择 Feat... (e.g. F188)"
            className="flex-1 text-xs bg-transparent text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
          />
          {selectedFeat && (
            <button
              type="button"
              onClick={() => {
                // Cloud round 5 P2 fix: bump the request id so any in-flight
                // loadTrajectory promise resolves into the discard branch
                // instead of repopulating projection after clear.
                requestIdRef.current += 1;
                setSelectedFeat(null);
                setQuery('');
                setProjection(null);
                setPickerOpen(true);
              }}
              className="text-neutral-500 hover:text-neutral-300 text-xs"
              title="清除选择"
            >
              ✕
            </button>
          )}
        </div>
        {/* 下拉候选 */}
        {pickerOpen && filtered.length > 0 && (
          <div className="absolute left-3 right-3 top-full mt-1 z-20 max-h-60 overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 shadow-xl">
            {filtered.map((f) => (
              <button
                key={f}
                type="button"
                onMouseDown={() => loadTrajectory(f)}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-neutral-800 transition-colors ${
                  f === selectedFeat ? 'text-conn-purple-text' : 'text-neutral-300'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 主区：时间轴 / 空 / loading / error */}
      <div className="flex-1 overflow-y-auto px-3 py-4">
        {!selectedFeat ? (
          <EmptyState loadingList={loadingList} hasFeats={featIds.length > 0} />
        ) : loadingTraj ? (
          <div className="flex items-center justify-center h-32 text-sm text-neutral-500">载入轨迹中...</div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-32 text-sm text-conn-amber-text gap-1.5">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => loadTrajectory(selectedFeat)}
              className="text-micro text-neutral-400 underline hover:text-neutral-200"
            >
              重试
            </button>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-neutral-500">
            {selectedFeat} 暂无轨迹数据
          </div>
        ) : (
          <>
            {/* 头部统计 */}
            <div className="mb-3 flex items-center gap-2 text-micro text-neutral-500">
              <span className="text-conn-purple-text font-semibold">{selectedFeat}</span>
              <span>{entries.length} 个事件</span>
              {projection && <SourceCounts counts={projection.countsBySource} />}
            </div>
            {/* 垂直时间轴 */}
            <div>
              {entries.map((entry) => (
                <TrajectoryCard key={entry.entryId} entry={entry} onJumpToThread={handleJumpToThread} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
