import type { ApprovalProducerId } from '@cat-cafe/shared';
import { MarkdownContent } from '@/components/MarkdownContent';
import { ApprovalMember } from '@/components/rich/ApprovalMember';
import { ApprovalResultHistory } from '@/components/rich/approval-result-history';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { approvalDisplayTitle, formatApprovalRelativeTime } from '@/lib/approval-presentation';
import { approvalResultRead } from '@/lib/approval-result-read';
import { useApprovalResult } from '@/lib/use-approval-result';
import { useShellCopy } from '../shell-copy';
import { useShellLanguage } from '../shell-language';
import { handledHistoryCopy } from './handled-history.shell-copy';
import { type OriginalPlace, resolveOriginalPlace } from './original-place';
import { SettledApprovalReceipt } from './SettledApprovalReceipt';
import { SettledRuntimeReceipt } from './SettledRuntimeReceipt';
import type { SettledResultItem } from './settled-results-source';

export function HandledApprovalRow({
  item: pageItem,
  reread,
  authorizeOpen,
  onOpenPlace,
}: {
  item: SettledResultItem;
  reread: () => void;
  authorizeOpen: () => boolean;
  onOpenPlace: (place: OriginalPlace) => void;
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
  const language = useShellLanguage();
  const t = useShellCopy(handledHistoryCopy);
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
  return (
    <li
      data-testid="mailbox-history-row"
      data-proposal-id={item.proposalId}
      className="min-w-0 border-b py-3"
      style={{ borderColor: 'var(--shell-hairline)' }}
    >
      <ApprovalResultHistory.Provider
        value={{
          subject: approvalDisplayTitle(item, { resolveCatName: resolveName, language }),
          proposer: resolveName(item.requesterCatId),
          kind,
          time: formatApprovalRelativeTime(item.decidedAt, Date.now(), language),
          retry: refresh,
          details: (
            <div className="space-y-2 text-xs">
              <ApprovalMember catId={item.requesterCatId} />
              <p>
                {item.decidedBy === item.ownerUserId ? t.you : t.actorUnknown} ·{' '}
                {new Date(item.decidedAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}
              </p>
              {typeof item.detail.reason === 'string' && item.detail.reason.trim() ? (
                <details data-testid="handled-reason">
                  <summary className="shell-focusable cursor-pointer">
                    {t.why} · {t.expand}
                  </summary>
                  <MarkdownContent content={item.detail.reason} className="!text-xs" disableCommandPrefix />
                </details>
              ) : null}
              {place.kind === 'exact' ? (
                <button
                  type="button"
                  className="shell-focusable hover:underline"
                  onClick={() => authorizeOpen() && onOpenPlace(place)}
                >
                  {t.original}
                </button>
              ) : null}
            </div>
          ),
        }}
      >
        {item.sourceFeatureId === 'F306' ? (
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
