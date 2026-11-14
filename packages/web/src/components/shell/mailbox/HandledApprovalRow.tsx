import type { ApprovalProducerId } from '@cat-cafe/shared';
import { useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { ApprovalMember } from '@/components/rich/ApprovalMember';
import { ApprovalResultRow } from '@/components/rich/ApprovalResultRow';
import { ApprovalResultHistory, HistoryTechnicalDetails } from '@/components/rich/approval-result-history';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { approvalDisplayTitle, formatApprovalRelativeTime } from '@/lib/approval-presentation';
import { approvalResultRead } from '@/lib/approval-result-read';
import { useApprovalResult } from '@/lib/use-approval-result';
import { useShellCopy } from '../shell-copy';
import { useShellLanguage } from '../shell-language';
import { handledHistoryCopy } from './handled-history.shell-copy';
import { type OriginalPlace, resolveOriginalPlace } from './original-place';
import { PersonProposalForget } from './PersonProposalForget';
import { personProposalForgetCopy } from './person-proposal-forget.shell-copy';
import { SettledApprovalReceipt } from './SettledApprovalReceipt';
import { SettledRuntimeReceipt } from './SettledRuntimeReceipt';
import type { SettledResultItem } from './settled-results-source';

export function HandledApprovalRow({
  item: pageItem,
  reread,
  authorizeOpen,
  onOpenPlace,
  onForgotten,
}: {
  item: SettledResultItem;
  reread: () => void;
  authorizeOpen: () => boolean;
  onOpenPlace: (place: OriginalPlace) => void;
  onForgotten?: (ids: string[], count: number) => void;
}) {
  const current = useApprovalResult<SettledResultItem | undefined>(
    pageItem.sourceFeatureId,
    pageItem.proposalId,
    'settled',
    async () => undefined,
    pageItem.ownerUserId,
    false,
  );
  const item = current.value ?? pageItem;
  const [forgotten, setForgotten] = useState<number | null>(null);
  const language = useShellLanguage();
  const t = useShellCopy(handledHistoryCopy);
  const forgetCopy = useShellCopy(personProposalForgetCopy);
  const resolveName = useCatNameResolver();
  const kind = producerKind(item.sourceFeatureId, language);
  const refresh = () => {
    approvalResultRead.invalidate({ producer: item.sourceFeatureId, proposalId: item.proposalId });
    reread();
  };
  const place = resolveOriginalPlace({
    decisionRef: item.proposalId,
    kind: 'approval',
    summary: item.summary,
    approval: { ...item, inlineApprovable: false },
    linkedNeedsMe: [],
  });
  const originalAction =
    place.kind === 'exact' ? (
      <button
        type="button"
        className="shell-focusable text-compact text-[var(--shell-primary-active)] hover:underline"
        onClick={() => authorizeOpen() && onOpenPlace(place)}
      >
        {t.original}
      </button>
    ) : null;
  if (forgotten !== null)
    return (
      <li className="border-b py-3 text-sm" style={{ borderColor: 'var(--shell-hairline)' }}>
        <output>{forgotten > 0 ? forgetCopy.forgotten(forgotten) : forgetCopy.alreadyAbsent}</output>
      </li>
    );
  return (
    <li
      data-testid="mailbox-history-row"
      data-proposal-id={item.proposalId}
      className="min-w-0 border-b py-3"
      style={{ borderColor: 'var(--shell-hairline)' }}
    >
      <ApprovalResultHistory.Provider
        value={{
          subject:
            item.sourceFeatureId === 'F276'
              ? approvalDisplayTitle(item, { resolveCatName: resolveName, language }).replace('人物提案', '人物提议')
              : approvalDisplayTitle(item, { resolveCatName: resolveName, language }),
          proposer: resolveName(item.requesterCatId),
          kind,
          time: formatApprovalRelativeTime(item.decidedAt, Date.now(), language),
          retry: refresh,
          actions:
            item.sourceFeatureId === 'F276' ? (
              <>
                {originalAction}
                {item.resolution !== 'accepted' ? (
                  <PersonProposalForget
                    proposalId={item.proposalId}
                    ownerUserId={item.ownerUserId}
                    authorize={authorizeOpen}
                    onForgotten={(count, ids) => {
                      setForgotten(count);
                      for (const proposalId of ids) approvalResultRead.invalidate({ producer: 'F276', proposalId });
                      if (onForgotten) onForgotten(ids, count);
                      else reread();
                    }}
                  />
                ) : null}
              </>
            ) : undefined,
          details: (
            <div className="space-y-2 text-compact">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <ApprovalMember catId={item.requesterCatId} />
                <span
                  className="text-xs text-[var(--shell-muted)]"
                  title={new Date(item.decidedAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}
                >
                  {item.decidedBy === item.ownerUserId ? t.you : t.actorUnknown} ·{' '}
                  {new Date(item.decidedAt).toLocaleTimeString(language === 'en' ? 'en-US' : 'zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              {item.sourceFeatureId === 'F276' ? (
                <p className="text-xs text-[var(--shell-muted)]">
                  {forgetCopy.proposed(new Date(item.createdAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN'))}
                </p>
              ) : null}
              {typeof item.detail.reason === 'string' && item.detail.reason.trim() ? (
                <details data-testid="handled-reason">
                  <summary className="shell-focusable cursor-pointer">
                    {t.why} · {t.expand}
                  </summary>
                  <MarkdownContent content={item.detail.reason} className="!text-xs" disableCommandPrefix />
                </details>
              ) : null}
              {item.sourceFeatureId !== 'F276' ? originalAction : null}
            </div>
          ),
        }}
      >
        {item.sourceFeatureId === 'F276' && item.navigation.state === 'legacy_unanchored' ? (
          <ApprovalResultRow
            status={
              item.resolution === 'accepted' ? 'approved' : item.resolution === 'rejected' ? 'rejected' : 'closed'
            }
            label={
              item.resolution === 'accepted'
                ? t.accepted
                : item.resolution === 'rejected'
                  ? t.rejected
                  : item.detail.replacedByProposalId
                    ? forgetCopy.superseded
                    : forgetCopy.withdrawn
            }
          >
            <p className="text-xs text-[var(--shell-muted)]">{forgetCopy.noSource}</p>
            <HistoryTechnicalDetails>
              <code className="break-all">{item.proposalId}</code>
            </HistoryTechnicalDetails>
          </ApprovalResultRow>
        ) : item.sourceFeatureId === 'F306' ? (
          <SettledRuntimeReceipt item={item} reread={refresh} />
        ) : (
          <SettledApprovalReceipt item={item} reread={refresh} authorizeOpen={authorizeOpen} />
        )}
      </ApprovalResultHistory.Provider>
    </li>
  );
}

export function producerKind(feature: ApprovalProducerId, language: 'zh' | 'en'): string {
  return handledHistoryCopy[language].kinds[feature];
}
