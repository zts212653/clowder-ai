import type { ApprovalItem, SettledApprovalItem } from '@cat-cafe/shared';
import { locateEvalRepairApproval } from '../../../infrastructure/harness-eval/eval-repair-approval-contracts.js';
import {
  type EvalRepairApprovalRecord,
  projectEvalRepairApprovals,
} from '../../../infrastructure/harness-eval/eval-repair-approval-projection.js';
import type { IReevalClosureEventLog } from '../../../infrastructure/harness-eval/reeval-closure-event-log.js';
import type { SettledHistoryPageOptions } from '../../../utils/settled-history-page.js';
import {
  type ApprovalDecisionRead,
  type IApprovalAdapter,
  type ListSettledOpts,
  projectApprovalDecisionRead,
} from '../ports/IApprovalAdapter.js';
import { projectSettledPage } from '../project-settled-page.js';

export class F266ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F266' as const;

  constructor(private readonly eventLog?: IReevalClosureEventLog) {}

  async listSettledPage(owner: string, options: SettledHistoryPageOptions) {
    if (!this.eventLog)
      throw Object.assign(new Error('F266 canonical history source unavailable'), {
        statusCode: 503,
        code: 'APPROVAL_HISTORY_UNAVAILABLE',
      });
    return projectSettledPage(
      { listSettledPage: this.eventLog.listApprovalHistoryPage?.bind(this.eventLog) },
      owner,
      options,
      (record) => toSettledItem(record, owner),
    );
  }

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

  async readDecision(userId: string, proposalId: string): Promise<ApprovalDecisionRead> {
    if (!this.eventLog) throw new Error('F266 canonical decision event log unavailable');
    const record = (await locateEvalRepairApproval(this.eventLog, proposalId))?.record;
    if (!record || record.proposal.requestOrigin.ownerUserId !== userId) return { state: 'closed' };
    if (record.lifecycle.resolution === 'open') return { state: 'pending' };
    const item = toSettledItem(record, userId);
    if (!item) return { state: 'closed' };
    return projectApprovalDecisionRead(
      item.status,
      () => item,
      record.decision?.reasonText ?? record.decision?.reasonCode,
    );
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
  const resultTime = record.supersededByCaseActionRef ? record.closedAt : record.decidedAt;
  return {
    proposalId: proposal.proposalId,
    sourceFeatureId: 'F266',
    requesterCatId: proposal.requestOrigin.requesterCatId,
    ownerUserId: proposal.requestOrigin.ownerUserId,
    status: settledStatus(record),
    summary: proposal.summary,
    detail: {
      ...proposal.detail,

      ...(!resultTime ? { closureTimeUnknown: true } : {}),
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
    decidedAt: resultTime ? Date.parse(resultTime) : 0,
    decidedBy: record.supersededByCaseActionRef ? '' : (record.decision?.decidedByUserId ?? ''),
  };
}

function settledStatus(record: EvalRepairApprovalRecord): SettledApprovalItem['status'] {
  if (record.lifecycle.resolution === 'accepted') return 'approved';
  if (record.lifecycle.resolution === 'rejected') return 'rejected';
  return record.supersededByCaseActionRef ? 'superseded' : 'withdrawn';
}
