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
import { approvalHistoryCopy } from './approval-history.shell-copy';
import { CompactLabel } from './content-overflow';
import { useShellCopy } from './shell/shell-copy';
import { useShellLanguage } from './shell/shell-language';

interface SettledHistoryCardProps {
  item: SettledApprovalHubItem;
}

export function SettledHistoryCard({ item }: SettledHistoryCardProps) {
  const t = useShellCopy(approvalHistoryCopy);
  const language = useShellLanguage();
  const resolveCatName = useCatNameResolver();
  const status = approvalLifecyclePresentation(item);
  const details: ApprovalCardDetails | undefined =
    Object.keys(item.detail).length > 0
      ? {
          label: t.details,
          expandedLabel: t.collapseDetails,
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
            className="inline-flex items-center gap-1.5 text-micro font-medium text-cafe-interactive"
            data-testid="settled-card-status"
          >
            <span
              aria-hidden="true"
              className="h-2 w-2 flex-none rounded-full"
              style={{
                backgroundColor:
                  status.tone === 'success'
                    ? 'var(--semantic-success)'
                    : status.tone === 'critical'
                      ? 'var(--semantic-critical)'
                      : 'var(--cafe-secondary)',
              }}
            />
            {t.lifecycle[item.resolution === 'accepted' ? item.materialization.state : item.resolution]}
          </span>
          {!item.detail.closureTimeUnknown ? (
            <span
              className="ml-auto shrink-0 text-micro text-cafe-interactive/40"
              data-testid="settled-card-time"
              title={t.decidedAt(formatApprovalAbsoluteTime(item.decidedAt, language))}
            >
              {t.decidedAt(formatApprovalRelativeTime(item.decidedAt, Date.now(), language))}
            </span>
          ) : null}
        </div>
      }
      title={approvalDisplayTitle(item, { resolveCatName, language })}
      titleLines={2}
      titleTestId="settled-card-summary"
      context={
        <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1" data-testid="settled-card-actors">
          <CompactLabel
            label={t.requester}
            value={`${t.requester}${language === 'zh' ? '：' : ': '}${resolveCatName(item.requesterCatId)}`}
            density="compact"
            className="min-w-0 flex-1 basis-48 text-micro text-cafe-secondary"
          />
          <CompactLabel
            label={t.decider}
            value={`${t.decider}${language === 'zh' ? '：' : ': '}${resolveCatName(item.decidedBy)}`}
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
