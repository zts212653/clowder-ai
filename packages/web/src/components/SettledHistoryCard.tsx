'use client';

/**
 * F246 Phase F: Settled approval history card.
 *
 * Displays a single approved/rejected proposal in the history tab.
 * Shows: feature badge, status chip (✅/❌), summary, requester, decidedAt timestamp.
 */

import type { SettledApprovalItem } from '@cat-cafe/shared';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';

const FEATURE_LABELS: Record<string, string> = {
  F128: '线程',
  F225: '会话',
  F193: '派发',
  F231: '画像',
};

function relativeTime(epochMs: number): string {
  const delta = Date.now() - epochMs;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(epochMs).toLocaleDateString('zh-CN');
}

interface SettledHistoryCardProps {
  item: SettledApprovalItem;
}

export function SettledHistoryCard({ item }: SettledHistoryCardProps) {
  const resolveCatName = useCatNameResolver();
  const featureLabel = FEATURE_LABELS[item.sourceFeatureId] ?? item.sourceFeatureId;
  const isApproved = item.status === 'approved';

  return (
    <div
      className="rounded-lg border border-cafe-subtle/30 bg-cafe-surface/40 p-3 space-y-1.5"
      data-testid={`settled-card-${item.proposalId}`}
    >
      {/* Header row: feature badge + status chip + time */}
      <div className="flex items-center gap-2">
        <span
          className="px-1.5 py-0.5 rounded text-micro font-medium bg-cafe-subtle/20 text-cafe-interactive/70"
          data-testid="settled-card-feature-badge"
        >
          {featureLabel}
        </span>
        <span
          className={`px-1.5 py-0.5 rounded text-micro font-semibold ${
            isApproved
              ? 'bg-[var(--semantic-success)]/10 text-[var(--semantic-success)]'
              : 'bg-[var(--semantic-critical)]/10 text-[var(--semantic-critical)]'
          }`}
          data-testid="settled-card-status"
        >
          {isApproved ? '✅ 已通过' : '❌ 已拒绝'}
        </span>
        <span className="ml-auto text-micro text-cafe-interactive/40" data-testid="settled-card-time">
          {relativeTime(item.decidedAt)}
        </span>
      </div>

      {/* Summary */}
      <p className="text-sm text-cafe-interactive/80 line-clamp-2" data-testid="settled-card-summary">
        {item.summary}
      </p>

      {/* Requester */}
      <p className="text-micro text-cafe-interactive/40">
        来自 <span className="font-medium">{resolveCatName(item.requesterCatId)}</span>
      </p>
    </div>
  );
}
