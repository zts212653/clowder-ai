'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import type { ProposalCardStatus } from './ProposalCardUtils';

export interface ProposalRecoveryRecord {
  proposalId: string;
  status: ProposalCardStatus;
  createdThreadId?: string;
  attentionGroupId?: string | null;
}
const statuses = new Set(['pending', 'approving', 'approved', 'rejected', 'withdrawn']);
function recordFrom(value: unknown, proposalId: string): ProposalRecoveryRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = 'proposal' in value ? value.proposal : value;
  if (!record || typeof record !== 'object' || !('proposalId' in record) || record.proposalId !== proposalId)
    return null;
  if (!('status' in record) || typeof record.status !== 'string' || !statuses.has(record.status)) return null;
  return {
    proposalId,
    status: record.status as ProposalCardStatus,
    ...('createdThreadId' in record && typeof record.createdThreadId === 'string'
      ? { createdThreadId: record.createdThreadId }
      : {}),
    ...('attentionGroupId' in record &&
    (record.attentionGroupId === null || typeof record.attentionGroupId === 'string')
      ? { attentionGroupId: record.attentionGroupId }
      : {}),
  };
}
function terminal(status: string | null, hasThread: boolean): boolean {
  return status === 'rejected' || status === 'withdrawn' || (status === 'approved' && hasThread);
}

/** Outcome truth stays in the shared producer reader; this owns only the card's recovery interaction. */
export function useProposalApprovalRecovery({
  proposalId,
  status,
  hasThread,
  approvedGroupId,
  read,
  reading,
  onRead,
  onApproved,
}: {
  proposalId: string | null;
  status: string | null;
  hasThread: boolean;
  approvedGroupId: string | null | undefined;
  read: () => Promise<unknown>;
  reading: boolean;
  onRead: (record: ProposalRecoveryRecord) => void;
  onApproved: () => void;
}) {
  const [mode, setMode] = useState<'none' | 'uncertain' | 'retryable' | 'placement'>('none');
  const current = useRef({ proposalId, status, hasThread, mounted: false });
  Object.assign(current.current, { proposalId, status, hasThread });
  useEffect(() => {
    current.current.mounted = true;
    setMode('none');
    return () => {
      current.current.mounted = false;
    };
  }, [proposalId]);
  useEffect(() => {
    if (mode !== 'none' && terminal(status, hasThread)) {
      if (status === 'approved' && approvedGroupId) {
        if (mode !== 'placement') {
          setMode('placement');
          onApproved();
        }
      } else {
        setMode('none');
        if (status === 'approved') onApproved();
      }
    }
  }, [status, hasThread, approvedGroupId, mode, onApproved]);

  const check = useCallback(
    async (explicit: boolean) => {
      if (!proposalId) return;
      const identity = apiSessionIdentity.getSnapshot();
      const value = await read();
      const active = current.current;
      if (!active.mounted || active.proposalId !== proposalId || identity !== apiSessionIdentity.getSnapshot()) return;
      const record = recordFrom(value, proposalId);
      if (!record) return;
      if (terminal(active.status, active.hasThread) && (active.status !== 'approved' || record.status !== 'approved'))
        return;
      onRead(record);
      if (record.status === 'approved' && record.createdThreadId) {
        // Finalization precedes Group placement. Keep an honest read-only exit, without another completion cache.
        setMode(record.attentionGroupId ? 'placement' : 'none');
        onApproved();
      } else if (explicit && record.status === 'pending') setMode('retryable');
    },
    [proposalId, read, onRead, onApproved],
  );

  useEffect(() => {
    if (mode !== 'uncertain' && mode !== 'placement') return;
    const recover = () => {
      if (navigator.onLine !== false) void check(false);
    };
    const visible = () => {
      if (document.visibilityState === 'visible') recover();
    };
    for (const event of ['focus', 'online', 'cat-cafe:socket-reconnected']) window.addEventListener(event, recover);
    document.addEventListener('visibilitychange', visible);
    return () => {
      for (const event of ['focus', 'online', 'cat-cafe:socket-reconnected'])
        window.removeEventListener(event, recover);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [mode, check]);

  const effectiveMode = terminal(status, hasThread)
    ? status === 'approved' && approvedGroupId && mode !== 'none'
      ? 'placement'
      : 'none'
    : mode;
  return {
    mode: effectiveMode,
    blocked: effectiveMode === 'uncertain',
    checking: reading,
    markUncertain: useCallback(() => setMode('uncertain'), []),
    reset: useCallback(() => setMode('none'), []),
    recheck: useCallback(() => check(true), [check]),
  };
}
