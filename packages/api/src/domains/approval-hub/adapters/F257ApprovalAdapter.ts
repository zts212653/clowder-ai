/** F257 cycle governance proposal → Approval Hub projection. */

import type { ApprovalItem, HarnessGovernanceProposal, SettledApprovalItem } from '@cat-cafe/shared';
import type { HarnessGovernanceProposalStore } from '../../../infrastructure/harness-eval/governance/HarnessGovernanceProposalStore.js';
import type { IApprovalAdapter, ListSettledOpts } from '../ports/IApprovalAdapter.js';

const DEFAULT_SETTLED_LIMIT = 50;

export class F257ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F257' as const;

  constructor(private readonly store: HarnessGovernanceProposalStore | undefined) {}

  async listPending(userId: string): Promise<ApprovalItem[]> {
    if (!this.store) return [];
    return (await this.store.listByOwner(userId))
      .filter((proposal) => proposal.status === 'pending')
      .map(toPending)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async listSettled(userId: string, opts?: ListSettledOpts): Promise<SettledApprovalItem[]> {
    if (!this.store) return [];
    return (await this.store.listByOwner(userId))
      .filter((proposal) => proposal.status !== 'pending')
      .map(toSettled)
      .sort((left, right) => right.decidedAt - left.decidedAt)
      .slice(0, opts?.limit ?? DEFAULT_SETTLED_LIMIT);
  }
}

function toPending(proposal: HarnessGovernanceProposal): ApprovalItem {
  return {
    proposalId: proposal.proposalId,
    sourceFeatureId: 'F257',
    requesterCatId: 'system',
    ownerUserId: proposal.ownerUserId,
    status: 'pending',
    summary: summary(proposal),
    detail: detail(proposal),
    navigation: { state: 'legacy_unanchored', legacyThreadId: proposal.threadId },
    inlineApprovable: true,
    decisionMode: 'approve-skip-reject',
    createdAt: proposal.createdAt,
  };
}

function toSettled(proposal: HarnessGovernanceProposal): SettledApprovalItem {
  return {
    proposalId: proposal.proposalId,
    sourceFeatureId: 'F257',
    requesterCatId: 'system',
    ownerUserId: proposal.ownerUserId,
    status: proposal.status === 'approved' ? 'approved' : proposal.status === 'skipped' ? 'skipped' : 'rejected',
    summary: summary(proposal),
    detail: detail(proposal),
    navigation: { state: 'legacy_unanchored', legacyThreadId: proposal.threadId },
    decisionMode: 'approve-skip-reject',
    decidedAt: proposal.decidedAt ?? proposal.createdAt,
    decidedBy: proposal.decidedBy ?? proposal.ownerUserId,
    createdAt: proposal.createdAt,
  };
}

function summary(proposal: HarnessGovernanceProposal): string {
  const units = [...new Set(proposal.changes.map((change) => change.unitId))].join(', ');
  return proposal.decision === 'rollback' ? `Harness 治理：回退 ${units}` : `Harness 治理：演进 ${units}`;
}

function detail(proposal: HarnessGovernanceProposal): Record<string, unknown> {
  const visuals = metricVisuals(proposal);
  return {
    header: {
      objective: structuredClone(proposal.objective),
      objectiveId: proposal.objectiveId,
      currentVersion: proposal.version,
      decision: proposal.decision,
      windows: structuredClone(proposal.windows),
      triggeredBy: [...proposal.triggeredBy],
      triggerCounts: structuredClone(proposal.triggerCounts),
    },
    conclusions: structuredClone(proposal.evaluation.metrics),
    coverageAssessment: proposal.evaluation.coverageAssessment
      ? structuredClone(proposal.evaluation.coverageAssessment)
      : null,
    metricVisuals: visuals,
    hasComparisonBaseline: visuals.some((metric) => metric.previousValue !== null),
    isFirstCycle: proposal.history.length === 0,
    governanceReason: proposal.reason,
    history: structuredClone(proposal.history),
    rejectReasons: [...proposal.rejectReasons],
    changes: structuredClone(proposal.changes),
    evidenceRefs: [...proposal.evidenceRefs],
    cardOrdinal: proposal.cardOrdinal,
    decisionReason: proposal.decisionReason,
  };
}

function metricVisuals(proposal: HarnessGovernanceProposal) {
  return proposal.evaluation.metrics.map((metric) => {
    const previous = proposal.history
      .flatMap((cycle) => cycle.evaluation.metrics)
      .find((candidate) => candidate.id === metric.id);
    const currentValue = conclusionValue(metric.conclusion);
    const previousValue = previous ? conclusionValue(previous.conclusion) : null;
    return {
      id: metric.id,
      currentValue,
      previousValue,
      delta: previousValue === null ? null : currentValue - previousValue,
      lowerIsBetter: metric.conclusion.kind !== 'semantic-label',
    };
  });
}

function conclusionValue(conclusion: HarnessGovernanceProposal['evaluation']['metrics'][number]['conclusion']): number {
  return conclusion.kind === 'semantic-label' ? conclusion.count : conclusion.value;
}
