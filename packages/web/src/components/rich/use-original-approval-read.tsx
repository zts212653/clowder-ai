'use client';
import { approvalResultRead } from '@/lib/approval-result-read';
import { useApprovalResult } from '@/lib/use-approval-result';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { SettledApprovalReceipt } from '../shell/mailbox/SettledApprovalReceipt';
import { SettledRuntimeReceipt } from '../shell/mailbox/SettledRuntimeReceipt';
import { type SettledResultItem } from '../shell/mailbox/settled-results-source';

/** A retained canonical result is display evidence. Every original writer still performs its fresh preflight. */
export function useOriginalApprovalRead<T>(
  producer: string,
  proposalId: string | null,
  binding: { threadId?: string; messageId?: string; block?: unknown },
  load: (signal: AbortSignal, fresh?: boolean) => Promise<T>,
  expectedOwner?: string,
  enabled = true,
  terminalDetails = false,
) {
  const canonical = useApprovalResult<SettledResultItem | undefined>(
    producer,
    proposalId,
    'settled',
    async () => undefined,
    expectedOwner,
    false,
  );
  const item = canonical.value;
  const key = { owner: canonical.ownerUserId ?? '', producer, proposalId: proposalId ?? '' };
  const retained =
    item &&
    approvalResultRead.isCurrent(key, 'settled') &&
    item.navigation.state === 'anchored' &&
    item.navigation.approvalCardRef.threadId === binding.threadId &&
    item.navigation.approvalCardRef.messageId === binding.messageId &&
    (item.resolution !== 'accepted' || item.materialization.state === 'succeeded' || item.sourceFeatureId === 'F306')
      ? item
      : null;
  const source = useApprovalResult(
    producer,
    proposalId,
    `original:${JSON.stringify(binding)}`,
    load,
    expectedOwner,
    enabled && (!retained || terminalDetails),
  );
  const reread = () => {
    approvalResultRead.invalidate({ producer, proposalId: proposalId ?? undefined });
    return source.refresh();
  };
  return { ...source, retained, reread };
}

export function RetainedApprovalCardResult({ item, reread }: { item: SettledResultItem; reread: () => void }) {
  if (item.sourceFeatureId === 'F306') return <SettledRuntimeReceipt item={item} reread={reread} />;
  return (
    <SettledApprovalReceipt
      item={item}
      reread={reread}
      authorizeOpen={() => apiSessionIdentity.getSnapshot().ownerUserId === item.ownerUserId}
    />
  );
}
