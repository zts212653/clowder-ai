'use client';
import type { ApprovalHubItem } from '@cat-cafe/shared';
import { useCallback } from 'react';
import type { ApprovalWriteKind } from '@/components/ApprovalHost';
import { useApprovalStatus } from './use-approval-status';

type TasteStatus = 'pending' | 'approving' | 'approved' | 'rejected';
/** The original owner-auth status, including recoverable writer claims hidden by the generic lifecycle projection. */
export function useTasteApprovalStatus(item: ApprovalHubItem) {
  const native = useApprovalStatus(
    'F221',
    item.sourceFeatureId === 'F221' ? item.proposalId : null,
    `/api/taste-proposals/${encodeURIComponent(item.proposalId)}`,
  );
  const status = ['pending', 'approving', 'approved', 'rejected'].includes(native.status ?? '')
    ? (native.status as TasteStatus)
    : null;
  const read = useCallback(async (): Promise<TasteStatus | null> => {
    const body = await native.refresh();
    if (
      !body ||
      typeof body !== 'object' ||
      !('proposalId' in body) ||
      body.proposalId !== item.proposalId ||
      !('status' in body) ||
      !['pending', 'approving', 'approved', 'rejected'].includes(String(body.status))
    )
      return null;
    return body.status as TasteStatus;
  }, [native.refresh, item.proposalId]);
  const refresh = useCallback(async () => {
    if (item.sourceFeatureId === 'F221') await native.refresh();
  }, [native.refresh, item.sourceFeatureId]);
  const beforeWrite = useCallback(
    async (kind: ApprovalWriteKind) => {
      if (item.sourceFeatureId !== 'F221') return true;
      const current = await read();
      return (current === 'pending' && item.resolution === 'open') || (current === 'approving' && kind === 'approve');
    },
    [read, item.resolution, item.sourceFeatureId],
  );
  return { status, beforeWrite, refresh };
}
