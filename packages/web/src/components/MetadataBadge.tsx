'use client';

import { useState } from 'react';
import type { ChatMessageMetadata } from '@/stores/chatStore';
import { formatCost, formatTokenCount } from './status-helpers';

interface MetadataBadgeProps {
  metadata: ChatMessageMetadata;
}

function cachePercent(input?: number, cacheRead?: number): number | null {
  if (!cacheRead || !input) return null;
  return Math.round((cacheRead / input) * 100);
}

export function MetadataBadge({ metadata }: MetadataBadgeProps) {
  const [expanded, setExpanded] = useState(false);

  // Read usage from message metadata (message-scoped, not per-cat aggregate)
  const usage = metadata.usage;

  const hasTokens = usage && (usage.inputTokens != null || usage.outputTokens != null || usage.totalTokens != null);
  const cachePct = usage ? cachePercent(usage.inputTokens, usage.cacheReadTokens) : null;

  return (
    <button
      onClick={() => setExpanded((v) => !v)}
      className="mt-1 text-[10px] text-cafe-muted hover:text-cafe-secondary transition-colors cursor-pointer select-none flex items-center gap-0 flex-wrap"
    >
      <span>
        {metadata.model || 'unknown'} · {metadata.provider || 'unknown'}
      </span>

      {hasTokens && (
        <span className="ml-1 animate-fade-in">
          <span className="text-cafe-muted"> · </span>
          {usage.inputTokens != null && (
            <span className="tabular-nums">
              {formatTokenCount(usage.inputTokens)}
              <span className="text-cafe-muted">↓</span>
            </span>
          )}
          {usage.outputTokens != null && (
            <span className="tabular-nums ml-0.5">
              {formatTokenCount(usage.outputTokens)}
              <span className="text-cafe-muted">↑</span>
            </span>
          )}
          {!usage.inputTokens && !usage.outputTokens && usage.totalTokens != null && (
            <span className="tabular-nums">
              {formatTokenCount(usage.totalTokens)}
              <span className="text-cafe-muted">tok</span>
            </span>
          )}
          {cachePct != null && cachePct > 0 && (
            <>
              <span className="text-cafe-muted"> · </span>
              <span className="text-emerald-500/80 tabular-nums">cached {cachePct}%</span>
            </>
          )}
          {usage.costUsd != null && (
            <>
              <span className="text-cafe-muted"> · </span>
              <span className="text-amber-500 animate-cost-glow tabular-nums">{formatCost(usage.costUsd)}</span>
            </>
          )}
        </span>
      )}

      {expanded && metadata.sessionId && (
        <span className="ml-1 text-cafe-muted">· {metadata.sessionId.slice(0, 12)}...</span>
      )}
    </button>
  );
}
