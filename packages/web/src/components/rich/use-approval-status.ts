'use client';
import { useEffect } from 'react';
import { fetchApprovalProducerBody } from '@/lib/approval-producer-read';
import { approvalResultRead } from '@/lib/approval-result-read';
import { useApprovalResult } from '@/lib/use-approval-result';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import type { SettledResultItem } from '../shell/mailbox/settled-results-source';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** Status and the original producer body are one shared part; a retained terminal needs no HTTP hydration. */
export function useApprovalStatus(
  producer: string,
  proposalId: string | null,
  path: string,
  enabled = true,
  expectedOwner?: string,
) {
  const canonical = useApprovalResult<SettledResultItem | undefined>(
    producer,
    proposalId,
    'settled',
    async () => undefined,
    expectedOwner,
    false,
  );
  const terminal =
    !canonical.stale &&
    canonical.value &&
    (canonical.value.resolution !== 'accepted' || canonical.value.materialization.state === 'succeeded')
      ? canonical.value
      : null;
  const native = useApprovalResult<unknown>(
    producer,
    proposalId,
    'native',
    (signal) =>
      fetchApprovalProducerBody(
        { owner: apiSessionIdentity.getSnapshot().ownerUserId ?? '', producer, proposalId: proposalId ?? '' },
        path,
        signal,
      ),
    expectedOwner,
    enabled && !terminal,
  );
  const record = object(native.value) && object(native.value.proposal) ? native.value.proposal : native.value;
  const status = terminal
    ? terminal.resolution === 'accepted'
      ? 'approved'
      : terminal.resolution === 'rejected'
        ? 'rejected'
        : (terminal.closedReason ?? 'closed')
    : object(record) && record.proposalId === proposalId && typeof record.status === 'string'
      ? record.status
      : null;
  useEffect(() => {
    if (proposalId && native.ownerUserId && status && ['rejected', 'expired', 'withdrawn'].includes(status))
      approvalResultRead.terminal({ owner: native.ownerUserId, producer, proposalId });
  }, [producer, proposalId, native.ownerUserId, status]);
  return { ...native, status, record, terminal };
}
