import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApprovalHostContext, PERMISSIVE_APPROVAL_HOST } from '@/components/ApprovalHost';
import { MemoryCorrectionApprovalCard } from '@/components/memory/page/MemoryCorrectionApprovalCard';
import { memoryCorrectionCopy } from '@/components/memory/page/memory-correction.shell-copy';
import { isCorrectionRecoveryProjection } from '@/components/memory/page/read-correction-approval';
import { isScheduleRecoveryProjection, sameScheduleValue } from '@/components/rich/read-schedule-approval';
import { ScheduleMutationProposalCard } from '@/components/rich/ScheduleMutationProposalCard';
import { scheduleApprovalCopy } from '@/components/rich/schedule-approval.shell-copy';
import { useShellCopy } from '../shell-copy';
import { type ApprovalSessions, sessionKey } from './approval-sessions';

/** Recovery is an original execution retry, not a new approval. Preserve accepted/unknown and the generic inline fence. */
export function MailboxExecutionRecoveryCard({
  item,
  ownerUserId,
  sessions,
  readCurrent,
  secondaryActions,
}: {
  item: UnifiedAttentionItemV1;
  ownerUserId: string;
  sessions: ApprovalSessions;
  readCurrent: boolean;
  secondaryActions?: ReactNode;
}) {
  const writing = useRef(false),
    [refused, setRefused] = useState(false);
  const t = useShellCopy(scheduleApprovalCopy);
  const correctionCopy = useShellCopy(memoryCorrectionCopy);
  useSyncExternalStore(sessions.subscribe, sessions.getVersion, sessions.getVersion);
  const approval = item.approval;
  const owned = useMemo(() => (approval ? { ...approval, ownerUserId } : null), [approval, ownerUserId]);
  if (!approval || !(isScheduleRecoveryProjection(approval) || isCorrectionRecoveryProjection(approval))) return null;
  const key = sessionKey(ownerUserId, approval),
    state = sessions.get(key)?.model.state;
  const phaseReady = !state || state.kind === 'idle' || state.kind === 'still_open';
  return (
    <ApprovalHostContext.Provider
      value={{
        ...PERMISSIVE_APPROVAL_HOST,
        presentation: 'mailbox',
        originalPlaceAction: secondaryActions,
        writesLocked: !readCurrent || !phaseReady || writing.current || !sessions.currentItem,
        authorizeWrite: () => {
          const current = sessions.currentItem?.(ownerUserId, item.decisionRef);
          const currentState = sessions.get(key)?.model.state;
          const ready = !currentState || currentState.kind === 'idle' || currentState.kind === 'still_open';
          if (!readCurrent || writing.current || !ready || !current || !sameScheduleValue(current, item)) {
            setRefused(true);
            return false;
          }
          // The original controller re-read the full owner proposal and canonical vector immediately before asking this host.
          sessions.open({ ownerUserId, decisionRef: item.decisionRef, approval });
          writing.current = true;
          setRefused(false);
          return true;
        },
        reportRequest: (event) => {
          sessions.hostReport(key, event);
          if (event.phase === 'end') writing.current = false;
        },
      }}
    >
      {owned ? (
        approval.sourceFeatureId === 'F139' ? (
          <ScheduleMutationProposalCard item={owned} />
        ) : (
          <MemoryCorrectionApprovalCard item={owned} />
        )
      ) : null}
      {refused ? (
        <p role="alert" className="text-sm text-cafe-muted">
          {approval.sourceFeatureId === 'F139' ? t.changed : correctionCopy.changed}
        </p>
      ) : null}
    </ApprovalHostContext.Provider>
  );
}
