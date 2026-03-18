'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

/** F122B AC-B8+B9: Per-cat execution status bar with stop controls.
 *  B8/B9 polish: cat names use formatCatName() — "品种（variant）" format, colors from cat-config. */
export function ThreadExecutionBar() {
  const activeInvocations = useChatStore((s) => s.activeInvocations);
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const { getCatById } = useCatData();
  const [, setTick] = useState(0);

  // Extract unique active cats from invocations
  const activeCats = Object.values(activeInvocations ?? {}).reduce(
    (acc, inv) => {
      if (!acc.some((c) => c.catId === inv.catId)) {
        acc.push({ catId: inv.catId, startedAt: inv.startedAt ?? Date.now() });
      }
      return acc;
    },
    [] as Array<{ catId: string; startedAt: number }>,
  );

  // Build display info from cat-config (dynamic, not hardcoded)
  const catDisplayMap = useMemo(() => {
    const map = new Map<string, { label: string; color: string }>();
    for (const { catId } of activeCats) {
      const cat = getCatById(catId);
      if (cat) {
        map.set(catId, {
          label: formatCatName(cat),
          color: cat.color.primary,
        });
      } else {
        map.set(catId, { label: catId, color: '#9B7EBD' });
      }
    }
    return map;
  }, [activeCats, getCatById]);

  // Auto-update elapsed time every second when cats are active
  useEffect(() => {
    if (activeCats.length === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [activeCats.length]);

  const handleStopCat = useCallback(
    async (catId: string) => {
      if (!currentThreadId) return;
      await apiFetch(`/api/threads/${currentThreadId}/cancel/${catId}`, { method: 'POST' });
    },
    [currentThreadId],
  );

  const handleStopAll = useCallback(async () => {
    if (!currentThreadId) return;
    await Promise.all(activeCats.map(({ catId }) => handleStopCat(catId)));
  }, [currentThreadId, activeCats, handleStopCat]);

  if (activeCats.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-xs border-b border-[#9B7EBD]/10">
      <span className="text-gray-400 font-medium shrink-0">执行中</span>
      {activeCats.map(({ catId, startedAt }) => {
        const info = catDisplayMap.get(catId) ?? { label: catId, color: '#9B7EBD' };
        return (
          <CatStatusChip
            key={catId}
            catId={catId}
            label={info.label}
            color={info.color}
            startedAt={startedAt}
            onStop={handleStopCat}
          />
        );
      })}
      {activeCats.length > 1 && (
        <button
          type="button"
          onClick={handleStopAll}
          className="ml-auto text-xs text-gray-400 hover:text-red-500 transition-colors shrink-0"
        >
          全部停止
        </button>
      )}
    </div>
  );
}

function CatStatusChip({
  catId,
  label,
  color,
  startedAt,
  onStop,
}: {
  catId: string;
  label: string;
  color: string;
  startedAt: number;
  onStop: (catId: string) => void;
}) {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  return (
    <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/50">
      <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: color }} />
      <span className="text-gray-600 font-medium">{label}</span>
      <span className="text-gray-400 tabular-nums">{timeStr}</span>
      <button
        type="button"
        onClick={() => onStop(catId)}
        className="ml-0.5 text-gray-400 hover:text-red-500 transition-colors"
        aria-label={`Stop ${catId}`}
      >
        <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </span>
  );
}
