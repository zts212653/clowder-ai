import type { CycleRecord, HarnessGovernanceProposal } from '@cat-cafe/shared';
import type { CycleEvaluationCoordinator } from '../evaluation/CycleEvaluationCoordinator.js';
import { adaptCycleTriggerPolicy } from '../evaluation/cycle-trigger-policy.js';
import type { ObjectiveEvaluationRuntime } from '../evaluation/ObjectiveEvaluationRuntime.js';
import type { HarnessGovernanceExecutor } from './HarnessGovernanceExecutor.js';
import type { HarnessGovernanceProposalStore } from './HarnessGovernanceProposalStore.js';

type ProposalStatus = 'approved' | 'skipped' | 'rejected';

export class CycleGovernanceProposalDecisions {
  constructor(
    private readonly deps: {
      runtime: ObjectiveEvaluationRuntime;
      evaluation: CycleEvaluationCoordinator;
      proposals: HarnessGovernanceProposalStore;
      executor: HarnessGovernanceExecutor;
      notify?: (ownerUserId: string, proposalId: string, status: ProposalStatus) => void;
      now: () => number;
    },
  ) {}

  async approve(ownerUserId: string, proposalId: string, actorId: string, reason: string) {
    return this.deps.proposals.withDecisionLock(proposalId, async () => {
      const proposal = await this.requireProposal(ownerUserId, proposalId);
      const current = await this.proposalCycle(proposal);
      if (proposal.status === 'approved' && !current) return { proposal, deduped: true };
      if (!current) throw new Error('harness_governance_cycle_not_active');
      const decidedAt = this.deps.now();
      const adaptation = adaptCycleTriggerPolicy(this.deps.runtime.catalog, current, proposal.decision, decidedAt);
      const version = await this.deps.executor.apply(proposal, actorId, reason, {
        triggerPolicy: adaptation.change.after,
        lifecycle: adaptation.lifecycle,
      });
      const settled = await this.deps.proposals.settle({
        proposalId,
        ownerUserId,
        status: 'approved',
        decidedAt,
        decidedBy: actorId,
        reason,
      });
      await this.closeCycle(current, settled, version, 'approved', reason, adaptation);
      this.notify(ownerUserId, proposalId, 'approved');
      return { proposal: settled, deduped: proposal.status === 'approved' };
    });
  }

  async skip(ownerUserId: string, proposalId: string, actorId: string, reason?: string) {
    return this.deps.proposals.withDecisionLock(proposalId, async () => {
      const proposal = await this.requireProposal(ownerUserId, proposalId);
      const current = await this.proposalCycle(proposal);
      if (proposal.status === 'skipped' && !current) return { proposal, deduped: true };
      if (!current) throw new Error('harness_governance_cycle_not_active');
      const decisionReason = reason?.trim() || 'operator_skip';
      const settled = await this.deps.proposals.settle({
        proposalId,
        ownerUserId,
        status: 'skipped',
        decidedAt: this.deps.now(),
        decidedBy: actorId,
        reason: decisionReason,
      });
      await this.closeCycle(
        current,
        settled,
        { version: current.version, versionContentRef: current.versionContentRef },
        'skipped',
        decisionReason,
        null,
      );
      this.notify(ownerUserId, proposalId, 'skipped');
      return { proposal: settled, deduped: proposal.status === 'skipped' };
    });
  }

  async reject(ownerUserId: string, proposalId: string, actorId: string, reason: string) {
    return this.deps.proposals.withDecisionLock(proposalId, async () => {
      if (!reason.trim()) throw new Error('harness_governance_reject_reason_required');
      const proposal = await this.requireProposal(ownerUserId, proposalId);
      let current = await this.proposalCycle(proposal);
      if (proposal.status === 'rejected' && current?.evalStatus === 'requested') {
        await this.deps.evaluation.ensureAssignment(current);
        return { proposal, deduped: true };
      }
      if (!current) throw new Error('harness_governance_cycle_not_active');
      const settled = await this.deps.proposals.settle({
        proposalId,
        ownerUserId,
        status: 'rejected',
        decidedAt: this.deps.now(),
        decidedBy: actorId,
        reason: reason.trim(),
      });
      const requested = resetForReevaluation(current, settled, reason.trim(), this.deps.now());
      if (!(await this.deps.runtime.cycles.transition(current, requested))) {
        current = await this.deps.runtime.cycles.current(ownerUserId, proposal.objectiveId);
        if (!current || current.cycleId !== proposal.cycleId || current.evalStatus !== 'requested') {
          throw new Error('harness_governance_cycle_concurrent_transition');
        }
      } else {
        current = requested;
      }
      await this.deps.evaluation.ensureAssignment(current);
      this.notify(ownerUserId, proposalId, 'rejected');
      return { proposal: settled, deduped: proposal.status === 'rejected' };
    });
  }

  private async closeCycle(
    current: CycleRecord,
    proposal: HarnessGovernanceProposal,
    version: Pick<CycleRecord, 'version' | 'versionContentRef'>,
    state: 'approved' | 'skipped',
    reason: string,
    adaptation: ReturnType<typeof adaptCycleTriggerPolicy> | null,
  ): Promise<void> {
    const decidedAt = proposal.decidedAt ?? this.deps.now();
    const completed: CycleRecord = {
      ...current,
      approval: {
        cardId: proposal.proposalId,
        state,
        reason,
        by: proposal.decidedBy,
        rejectCount: proposal.cardOrdinal - 1,
        at: decidedAt,
      },
      ...(adaptation ? { triggerPolicyChange: adaptation.change, objectiveLifecycle: adaptation.lifecycle } : {}),
      closedAt: decidedAt,
    };
    const next = await this.deps.runtime.cycles.advance(current, completed, version);
    if (next) return;
    const archived = await this.deps.runtime.cycles.historyCycle(
      current.ownerUserId,
      current.objectiveId,
      current.cycleId,
    );
    if (archived?.approval?.state !== state) throw new Error('harness_governance_cycle_concurrent_transition');
  }

  private async requireProposal(ownerUserId: string, proposalId: string): Promise<HarnessGovernanceProposal> {
    const proposal = await this.deps.proposals.get(proposalId);
    if (!proposal || proposal.ownerUserId !== ownerUserId) throw new Error('harness_governance_proposal_not_found');
    return proposal;
  }

  private async proposalCycle(proposal: HarnessGovernanceProposal): Promise<CycleRecord | null> {
    const current = await this.deps.runtime.cycles.current(proposal.ownerUserId, proposal.objectiveId);
    if (current?.cycleId === proposal.cycleId && current.approval?.cardId === proposal.proposalId) return current;
    return null;
  }

  private notify(ownerUserId: string, proposalId: string, status: ProposalStatus): void {
    try {
      this.deps.notify?.(ownerUserId, proposalId, status);
    } catch {
      /* websocket projection is best-effort after durable state */
    }
  }
}

function resetForReevaluation(
  current: CycleRecord,
  proposal: HarnessGovernanceProposal,
  reason: string,
  at: number,
): CycleRecord {
  const {
    evaluation: _evaluation,
    governance: _governance,
    assignmentMessageId: _assignmentMessageId,
    assignedAt: _assignedAt,
    retriggerMessageId: _retriggerMessageId,
    retriggeredAt: _retriggeredAt,
    stalledAlertMessageId: _stalledAlertMessageId,
    stalledAt: _stalledAt,
    governanceAssignmentMessageId: _governanceAssignmentMessageId,
    governanceAssignedAt: _governanceAssignedAt,
    governanceReminderMessageId: _governanceReminderMessageId,
    governanceRemindedAt: _governanceRemindedAt,
    ...base
  } = current;
  return {
    ...base,
    evalStatus: 'requested',
    approval: {
      cardId: proposal.proposalId,
      state: 'rejected',
      reason,
      by: proposal.decidedBy,
      rejectCount: proposal.cardOrdinal,
      at: proposal.decidedAt ?? at,
    },
    rejectReasons: [...(current.rejectReasons ?? []), reason],
  };
}
