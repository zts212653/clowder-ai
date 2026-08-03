'use client';

/** F246 compact settled-history row. */

import type { SettledApprovalItem } from '@cat-cafe/shared';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { approvalFeatureMeta } from '@/lib/approval-features';
import { ApprovalProvenanceLinks } from './ApprovalProvenanceLinks';

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
  const featureMeta = approvalFeatureMeta(item.sourceFeatureId);
  const isApproved = item.status === 'approved';

  return (
    <div
      className="group px-3 py-2.5 transition-colors hover:bg-cafe-surface/55"
      data-testid={`settled-card-${item.proposalId}`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="flex items-center gap-1 text-micro font-medium text-cafe-interactive/60"
          data-testid="settled-card-feature-badge"
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: featureMeta.color }} />
          {featureMeta.label}
        </span>
        <span
          className={`text-micro font-medium ${
            isApproved ? 'text-[var(--semantic-success)]' : 'text-[var(--semantic-critical)]'
          }`}
          data-testid="settled-card-status"
        >
          {isApproved ? '✅ 已通过' : '❌ 已拒绝'}
        </span>
        <span className="truncate text-micro text-cafe-interactive/35">来自 {resolveCatName(item.requesterCatId)}</span>
        <span className="ml-auto text-micro text-cafe-interactive/40" data-testid="settled-card-time">
          {relativeTime(item.decidedAt)}
        </span>
      </div>

      <div className="mt-1 flex items-start gap-2">
        <p className="line-clamp-2 min-w-0 flex-1 text-sm text-cafe-interactive/80" data-testid="settled-card-summary">
          {item.summary}
        </p>
      </div>
      <div className="mt-1">
        <ApprovalProvenanceLinks navigation={item.navigation} compact />
      </div>
    </div>
  );
}
