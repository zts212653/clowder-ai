'use client';

/** F246 compact settled-history row. */

import type { SettledApprovalHubItem } from '@cat-cafe/shared';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import {
  approvalDisplayTitle,
  approvalLifecyclePresentation,
  formatApprovalAbsoluteTime,
  formatApprovalRelativeTime,
} from '@/lib/approval-presentation';
import { type ApprovalCardDetails, ApprovalCardShell } from './ApprovalCardShell';
import { ApprovalFeatureBadge } from './ApprovalFeatureBadge';
import { ApprovalProvenanceLinks } from './ApprovalProvenanceLinks';
import { ApprovalTechnicalDetailContent } from './ApprovalTechnicalDetails';
import { CompactLabel } from './content-overflow';

interface SettledHistoryCardProps {
  item: SettledApprovalHubItem;
}

export function SettledHistoryCard({ item }: SettledHistoryCardProps) {
  const resolveCatName = useCatNameResolver();
  const status = approvalLifecyclePresentation(item);
  const details: ApprovalCardDetails | undefined =
    Object.keys(item.detail).length > 0
      ? {
          label: '查看技术详情',
          expandedLabel: '收起技术详情',
          testId: 'settled-card-technical-details',
          content: <ApprovalTechnicalDetailContent detail={item.detail} />,
        }
      : undefined;

  return (
    <ApprovalCardShell
      testId={`settled-card-${item.proposalId}`}
      className="group transition-colors hover:bg-cafe-surface/55"
      header={
        <div className="flex min-w-0 items-center gap-1.5">
          <ApprovalFeatureBadge featureId={item.sourceFeatureId} testId="settled-card-feature-badge" />
          <span
            className={`text-micro font-medium ${
              status.tone === 'success'
                ? 'text-[var(--semantic-success)]'
                : status.tone === 'critical'
                  ? 'text-[var(--semantic-critical)]'
                  : 'text-cafe-secondary'
            }`}
            data-testid="settled-card-status"
          >
            {status.label}
          </span>
          <span
            className="ml-auto shrink-0 text-micro text-cafe-interactive/40"
            data-testid="settled-card-time"
            title={`处理于 ${formatApprovalAbsoluteTime(item.decidedAt)}`}
          >
            处理于 {formatApprovalRelativeTime(item.decidedAt)}
          </span>
        </div>
      }
      title={approvalDisplayTitle(item)}
      titleLines={2}
      titleTestId="settled-card-summary"
      context={
        <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1" data-testid="settled-card-actors">
          <CompactLabel
            label="发起人"
            value={`发起人：${resolveCatName(item.requesterCatId)}`}
            density="compact"
            className="min-w-0 flex-1 basis-48 text-micro text-cafe-secondary"
          />
          <CompactLabel
            label="决定人"
            value={`决定人：${resolveCatName(item.decidedBy)}`}
            density="compact"
            className="min-w-0 flex-1 basis-48 text-micro text-cafe-secondary"
          />
        </div>
      }
      actions={
        <div className="border-t border-cafe-subtle pt-2">
          <ApprovalProvenanceLinks navigation={item.navigation} compact />
        </div>
      }
      details={details}
    />
  );
}
