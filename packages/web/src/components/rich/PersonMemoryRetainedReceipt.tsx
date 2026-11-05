'use client';
import type { UnifiedAttentionVisibleApproval } from '@cat-cafe/shared';
import { type ReactNode, useState } from 'react';
import type { Terminal } from '../shell/mailbox/approval-reconcile';
import { approvalReconcileCopy } from '../shell/mailbox/approval-reconcile.shell-copy';
import { useShellCopy } from '../shell/shell-copy';
import { ApprovalResultRow } from './ApprovalResultRow';
import { decisionResultCopy } from './decision-result.shell-copy';
import { PersonMemoryUndo } from './PersonMemoryUndo';
import { personMemoryCopy } from './person-memory.shell-copy';
import { personMemoryResultLabel, personMemorySnapshotResult, personMemoryWriteCount } from './person-memory-result';
import { usePersonMemoryProposal } from './use-person-memory-proposal';

/** Decision results keep the producer's exact reversible receipt even after the pending row retires. */
export function PersonMemoryRetainedReceipt({
  approval,
  ownerUserId,
  terminal,
  children,
  deferProducerRead = false,
  onExpandedChange,
}: {
  approval: UnifiedAttentionVisibleApproval;
  ownerUserId?: string;
  terminal?: Terminal;
  children?: ReactNode;
  deferProducerRead?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const t = useShellCopy(personMemoryCopy);
  const resultCopy = useShellCopy(decisionResultCopy);
  const phaseCopy = useShellCopy(approvalReconcileCopy);
  const phase = terminal?.resolution === 'accepted' ? approval.materialization.state : null;
  const phaseLabel = phase === 'in_progress' ? phaseCopy.inProgress : phase === 'failed' ? phaseCopy.writeFailed : null;
  const ref = approval.navigation.state === 'anchored' ? approval.navigation.approvalCardRef : undefined;
  const [requested, setRequested] = useState(!deferProducerRead);
  const expandedChange = (value: boolean) => {
    if (value) setRequested(true);
    onExpandedChange?.(value);
  };
  const read = usePersonMemoryProposal(approval.proposalId, ref, undefined, ownerUserId, requested, requested);
  const snapshot = read.source?.snapshot,
    receipt = snapshot?.decisionReceipt;
  const name = typeof approval.detail.displayName === 'string' ? approval.detail.displayName : null;
  if (!requested && terminal) {
    const status =
      terminal.resolution === 'accepted'
        ? 'approved'
        : terminal.resolution === 'rejected'
          ? 'rejected'
          : (terminal.closedReason ?? 'closed');
    const materialized = approval.detail.materialized;
    const hasWriteProof = Boolean(
      materialized &&
        typeof materialized === 'object' &&
        ['claims', 'relationships', 'events'].every((key) => {
          const value = (materialized as Record<string, unknown>)[key];
          return typeof value === 'number' && Number.isInteger(value) && value >= 0;
        }),
    );
    const outcome =
      status === 'approved'
        ? hasWriteProof
          ? 'materialized'
          : 'approved_unknown'
        : status === 'rejected'
          ? 'rejected'
          : status === 'withdrawn'
            ? approval.detail.undoApplied === true
              ? 'undone'
              : 'withdrawn'
            : 'closed';
    return (
      <ApprovalResultRow
        status={status === 'rejected' && approval.detail.hasRetainedWrites === true ? 'approved' : status}
        warning={outcome === 'approved_unknown' && phase === 'failed'}
        label={
          outcome === 'approved_unknown' && phaseLabel
            ? `${resultCopy.approved} · ${phaseLabel}`
            : personMemoryResultLabel(
                outcome,
                name,
                t,
                resultCopy,
                approval.detail.hasRetainedWrites === true,
                personMemoryWriteCount(approval.detail.materialized),
              )
        }
        onExpandedChange={expandedChange}
      >
        {children}
      </ApprovalResultRow>
    );
  }
  const actual = snapshot ? personMemorySnapshotResult(snapshot) : null;
  const aligned =
    !terminal ||
    Boolean(
      snapshot &&
        (actual?.undoApplied ||
          snapshot.replacedByProposalId ||
          (terminal.resolution === 'accepted' &&
            ['materialized', 'partially_materialized'].includes(snapshot.status)) ||
          (terminal.resolution === 'rejected' && snapshot.status === 'rejected') ||
          (terminal.resolution === 'closed_without_decision' && ['withdrawn', 'not_now'].includes(snapshot.status))),
    );
  if (!snapshot || !ref || !aligned || snapshot.status === 'pending_approval')
    return (
      <ApprovalResultRow
        status="closed"
        label={
          snapshot?.status === 'pending_approval'
            ? t.reopened
            : phaseLabel
              ? `${resultCopy.approved} · ${phaseLabel}`
              : resultCopy.unknown
        }
        warning={!snapshot && phase === 'failed'}
        onExpandedChange={expandedChange}
      >
        {t.kind}
        {name ? <p data-testid="person-memory-result-subject">{t.person(name)}</p> : null}
        <p>{t.unverified}</p>
        <button
          type="button"
          disabled={read.checking}
          onClick={() => void read.refresh()}
          className="shell-focusable text-xs hover:underline"
        >
          {!snapshot && phase === 'failed' ? phaseCopy.retry : t.reread}
        </button>
      </ApprovalResultRow>
    );
  const result = personMemorySnapshotResult(snapshot);
  return (
    <ApprovalResultRow
      status={result.status}
      label={personMemoryResultLabel(
        result.outcome,
        name,
        t,
        resultCopy,
        snapshot.hasRetainedWrites === true,
        personMemoryWriteCount(snapshot.materialized),
      )}
      onExpandedChange={expandedChange}
    >
      {name ? <p data-testid="person-memory-result-subject">{t.person(name)}</p> : null}
      {receipt && !result.undoApplied ? (
        <p>
          {t.receipt(
            receipt.materializedClaimIds.length,
            receipt.materializedRelationshipIds.length,
            receipt.materializedEventIds.length,
          )}
        </p>
      ) : null}
      <PersonMemoryUndo
        proposalId={approval.proposalId}
        messageId={ref.messageId}
        snapshot={snapshot}
        afterWrite={() => read.refresh()}
      />
      {children}
    </ApprovalResultRow>
  );
}
