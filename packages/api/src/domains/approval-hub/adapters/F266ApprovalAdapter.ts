import type { ApprovalItem, SettledApprovalItem } from '@cat-cafe/shared';
import {
  type EvalRepairApprovalRecord,
  projectEvalRepairApprovals,
} from '../../../infrastructure/harness-eval/eval-repair-approval-projection.js';
import type { IReevalClosureEventLog } from '../../../infrastructure/harness-eval/reeval-closure-event-log.js';
import type { IApprovalAdapter, ListSettledOpts } from '../ports/IApprovalAdapter.js';

export class F266ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F266' as const;

  constructor(private readonly eventLog?: IReevalClosureEventLog) {}

  async listPending(userId: string): Promise<ApprovalItem[]> {
    if (!this.eventLog) return [];
    const records = await this.readRecords();
    return records.flatMap((record) => {
      const proposal = record.proposal;
      if (
        proposal.requestOrigin.ownerUserId !== userId ||
        record.lifecycle.resolution !== 'open' ||
        record.publication.state !== 'anchored'
      ) {
        return [];
      }
      return [
        {
          proposalId: proposal.proposalId,
          sourceFeatureId: 'F266',
          requesterCatId: proposal.requestOrigin.requesterCatId,
          ownerUserId: proposal.requestOrigin.ownerUserId,
          status: 'pending',
          summary: proposal.summary,
          detail: proposal.detail,
          navigation: {
            state: 'anchored',
            originRef: record.publication.envelope.originRef,
            approvalCardRef: record.publication.envelope.approvalCardRef,
          },
          inlineApprovable: true,
          decisionMode: 'approve-reject',
          createdAt: Date.parse(proposal.occurredAt),
        },
      ];
    });
  }

  async listSettled(userId: string, opts?: ListSettledOpts): Promise<SettledApprovalItem[]> {
    if (!this.eventLog) return [];
    const limit = opts?.limit ?? 50;
    const records = await this.readRecords();
    return records
      .flatMap((record) => {
        const item = toSettledItem(record, userId);
        return item ? [item] : [];
      })
      .sort((left, right) => right.decidedAt - left.decidedAt)
      .slice(0, limit);
  }

  private async readRecords() {
    const eventLog = this.eventLog;
    if (!eventLog) return [];
    const subjects = await eventLog.listSubjectIds();
    return (
      await Promise.all(
        subjects.map(async (subjectId) => projectEvalRepairApprovals(await eventLog.read(subjectId)).proposals),
      )
    ).flat();
  }
}

function toSettledItem(record: EvalRepairApprovalRecord, userId: string): SettledApprovalItem | null {
  const proposal = record.proposal;
  if (
    proposal.requestOrigin.ownerUserId !== userId ||
    record.lifecycle.resolution === 'open' ||
    record.publication.state !== 'anchored'
  ) {
    return null;
  }
  return {
    proposalId: proposal.proposalId,
    sourceFeatureId: 'F266',
    requesterCatId: proposal.requestOrigin.requesterCatId,
    ownerUserId: proposal.requestOrigin.ownerUserId,
    status: settledStatus(record),
    summary: proposal.summary,
    detail: {
      ...proposal.detail,
      ...(record.materialization
        ? { canonicalEffectProofRef: record.materialization.custodyReceiptRef.ownerStateRef }
        : {}),
    },
    navigation: {
      state: 'anchored',
      originRef: record.publication.envelope.originRef,
      approvalCardRef: record.publication.envelope.approvalCardRef,
    },
    decisionMode: 'approve-reject',
    createdAt: Date.parse(proposal.occurredAt),
    decidedAt: Date.parse(record.decidedAt ?? proposal.occurredAt),
    decidedBy: record.decision?.decidedByUserId ?? 'eval-repair-materializer',
  };
}

function settledStatus(record: EvalRepairApprovalRecord): SettledApprovalItem['status'] {
  if (record.lifecycle.resolution === 'accepted') return 'approved';
  if (record.lifecycle.resolution === 'rejected') return 'rejected';
  return record.supersededByCaseActionRef ? 'superseded' : 'withdrawn';
}
