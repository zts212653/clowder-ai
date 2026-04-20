'use client';

import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { hexToRgba } from '@/lib/color-utils';
import type { TokenUsage } from '@/stores/chat-types';
import type { CatInvocationInfo } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';
import { deriveActiveCats, formatCost, formatDuration, formatTokenCount } from './status-helpers';

function StatusDot({ status }: { status: string }) {
  switch (status) {
    case 'pending':
      return <span className="inline-block w-2 h-2 rounded-full bg-gray-300 animate-pulse" />;
    case 'streaming':
      return <span className="inline-block w-2 h-2 rounded-full bg-green-400 animate-pulse" />;
    case 'done':
      return <span className="text-green-500 text-xs">&#10003;</span>;
    case 'error':
      return <span className="text-red-500 text-xs">&#10007;</span>;
    case 'alive_but_silent':
      return <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />;
    case 'suspected_stall':
      return <span className="inline-block w-2 h-2 rounded-full bg-orange-500 animate-pulse" />;
    default:
      return null;
  }
}

function CatStatusCard({
  catId,
  status,
  invocation,
}: {
  catId: string;
  status: string;
  invocation?: { startedAt?: number; durationMs?: number };
}) {
  const { getCatById } = useCatData();
  const cat = getCatById(catId);
  const elapsed = useElapsedTime(status === 'streaming' ? invocation?.startedAt : undefined);

  const timeDisplay = (() => {
    if (status === 'done' && invocation?.durationMs != null) {
      return formatDuration(invocation.durationMs);
    }
    if (status === 'streaming' && elapsed > 0) {
      return formatDuration(elapsed);
    }
    return null;
  })();

  const bgColor = cat ? hexToRgba(cat.color.primary, 0.12) : undefined;

  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
      style={{ backgroundColor: bgColor ?? '#f3f4f6' }}
    >
      <StatusDot status={status} />
      <span className="text-xs font-medium" style={{ color: cat?.color.primary ?? '#4b5563' }}>
        {cat ? formatCatName(cat) : catId}
      </span>
      {timeDisplay && <span className="text-xs text-cafe-secondary ml-0.5">{timeDisplay}</span>}
    </div>
  );
}

/** Aggregate token usage across cat invocations, optionally filtered to specific cats */
export function aggregateUsage(
  invocations: Record<string, CatInvocationInfo>,
  filterCatIds?: string[],
): TokenUsage | null {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let count = 0;

  const entries = filterCatIds ? filterCatIds.map((id) => invocations[id]).filter(Boolean) : Object.values(invocations);

  for (const inv of entries) {
    const u = inv.usage;
    if (!u) continue;
    count++;
    if (u.inputTokens != null) inputTokens += u.inputTokens;
    if (u.outputTokens != null) outputTokens += u.outputTokens;
    if (u.totalTokens != null && u.inputTokens == null) inputTokens += u.totalTokens;
    if (u.costUsd != null) costUsd += u.costUsd;
  }

  if (count === 0) return null;
  return {
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(costUsd > 0 ? { costUsd } : {}),
  };
}

export function ParallelStatusBar({ onStop }: { onStop?: () => void }) {
  const { targetCats, catStatuses, catInvocations, activeInvocations, hasActiveInvocation } = useChatStore();
  const activeCats = deriveActiveCats({
    targetCats,
    activeInvocations,
    hasActiveInvocation,
  });

  if (activeCats.length === 0) return null;

  const agg = aggregateUsage(catInvocations, activeCats);

  return (
    <div className="px-5 py-2.5 bg-gradient-to-r from-opus-bg via-codex-bg to-gemini-bg border-b border-cafe">
      <div className="flex items-center gap-4">
        <span className="text-sm font-medium text-cafe-secondary">独立观点采样中</span>
        {activeCats.map((catId) => (
          <CatStatusCard
            key={catId}
            catId={catId}
            status={catStatuses[catId] ?? 'pending'}
            invocation={catInvocations[catId]}
          />
        ))}
        {onStop && (
          <button
            onClick={() => onStop()}
            className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-full bg-red-50 text-red-500 hover:bg-red-100 hover:text-red-600 transition-colors text-xs font-medium"
            title="停止所有猫猫"
            aria-label="Stop all cats"
            data-testid="parallel-stop-button"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <rect x="4" y="4" width="12" height="12" rx="2" />
            </svg>
            停止
          </button>
        )}
      </div>
      {agg && (
        <div
          className="flex items-center gap-3 mt-1.5 text-[11px] text-cafe-secondary"
          data-testid="parallel-usage-summary"
        >
          {agg.inputTokens != null && (
            <span>
              In: <span className="font-medium text-cafe-secondary">{formatTokenCount(agg.inputTokens)}</span>
            </span>
          )}
          {agg.outputTokens != null && (
            <span>
              Out: <span className="font-medium text-cafe-secondary">{formatTokenCount(agg.outputTokens)}</span>
            </span>
          )}
          {agg.costUsd != null && (
            <span>
              Cost: <span className="font-medium text-amber-600">{formatCost(agg.costUsd)}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
