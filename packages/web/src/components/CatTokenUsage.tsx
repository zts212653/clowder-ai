'use client';

import { useCountUp } from '@/hooks/useCountUp';
import type { ContextHealthData, TokenUsage } from '@/stores/chat-types';
import { ContextHealthBar } from './ContextHealthBar';
import { formatCost, formatDuration, formatTokenCount } from './status-helpers';
import { TokenCacheBar } from './TokenCacheBar';

export interface CatTokenUsageProps {
  catId: string;
  usage: TokenUsage;
  /** F24: Context health data */
  contextHealth?: ContextHealthData;
}

const CAT_TEXT_COLORS: Record<string, string> = {
  opus: 'text-opus-dark',
  codex: 'text-codex-dark',
  gemini: 'text-gemini-dark',
  dare: 'text-dare-dark',
};

function cachePercent(usage: TokenUsage): number {
  if (!usage.cacheReadTokens || !usage.inputTokens) return 0;
  return Math.round((usage.cacheReadTokens / usage.inputTokens) * 100);
}

function AnimatedTokenCount({ value, label }: { value: number; label: string }) {
  const display = useCountUp(value);
  return (
    <span className="tabular-nums" title={`${label}: ${value.toLocaleString()}`}>
      {formatTokenCount(display)}
    </span>
  );
}

function formatContextWindowShort(value: number): string {
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return value.toLocaleString();
}

function formatMonthDay(tsMs: number): string {
  const date = new Date(tsMs);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * F8: Per-cat token usage dashboard card.
 * Dynamic display with count-up animations, cache progress bar, and brand colors.
 */
export function CatTokenUsage({ catId, usage, contextHealth }: CatTokenUsageProps) {
  const hasDetailed = usage.inputTokens != null || usage.outputTokens != null;
  const hasTotalOnly = !hasDetailed && usage.totalTokens != null;

  if (!hasDetailed && !hasTotalOnly) return null;

  const textColor = CAT_TEXT_COLORS[catId] ?? 'text-cafe-secondary';
  const cachePct = cachePercent(usage);
  const hasExactContextSummary =
    usage.contextUsedTokens != null && usage.contextWindowSize != null && usage.contextWindowSize > 0;
  const contextLeftPct = hasExactContextSummary
    ? Math.max(0, Math.round((1 - usage.contextUsedTokens! / usage.contextWindowSize!) * 100))
    : null;
  const contextSummary = hasExactContextSummary
    ? `Context: ${contextLeftPct}% left (${usage.contextUsedTokens?.toLocaleString()} used / ${formatContextWindowShort(usage.contextWindowSize!)})`
    : null;
  const contextResetDay = usage.contextResetsAtMs != null ? formatMonthDay(usage.contextResetsAtMs) : '';
  const contextResetLabel = contextResetDay ? `(resets ${contextResetDay})` : null;

  return (
    <div className="mt-1.5 space-y-1 animate-fade-in" data-testid={`token-usage-${catId}`}>
      {/* Token counts row */}
      <div className="flex items-baseline gap-2 font-mono text-[11px]">
        {hasDetailed && (
          <>
            {usage.inputTokens != null && (
              <span className={textColor}>
                <AnimatedTokenCount value={usage.inputTokens} label="Input" />
                <span className="text-cafe-muted ml-0.5">↓</span>
              </span>
            )}
            {usage.outputTokens != null && (
              <span className="text-cafe-secondary">
                <AnimatedTokenCount value={usage.outputTokens} label="Output" />
                <span className="text-cafe-muted ml-0.5">↑</span>
              </span>
            )}
          </>
        )}
        {hasTotalOnly && usage.totalTokens != null && (
          <span className={textColor}>
            <AnimatedTokenCount value={usage.totalTokens} label="Total" />
            <span className="text-cafe-muted ml-0.5">tok</span>
          </span>
        )}
      </div>

      {/* Cache bar */}
      {cachePct > 0 && (
        <div>
          <div className="text-[10px] text-cafe-muted mb-0.5">缓存命中</div>
          <TokenCacheBar percent={cachePct} catId={catId} />
        </div>
      )}

      {/* Cost + duration row */}
      <div className="flex items-center gap-2 text-[10px]">
        {usage.costUsd != null && (
          <span className="text-amber-600 font-medium tabular-nums animate-cost-glow">{formatCost(usage.costUsd)}</span>
        )}
        {usage.numTurns != null && usage.numTurns > 1 && (
          <span className="text-cafe-muted">{usage.numTurns} turns</span>
        )}
        {usage.durationApiMs != null && (
          <span className="text-cafe-muted">API {formatDuration(usage.durationApiMs)}</span>
        )}
      </div>

      {contextSummary && (
        <div className="text-[10px] text-cafe-secondary font-mono">
          {contextSummary}
          {contextResetLabel && <span className="text-cafe-muted ml-1">{contextResetLabel}</span>}
        </div>
      )}

      {/* F24: Context health bar */}
      {contextHealth && (
        <div>
          <div className="text-[10px] text-cafe-muted mb-0.5">上下文占用</div>
          <ContextHealthBar catId={catId} health={contextHealth} />
        </div>
      )}
    </div>
  );
}
