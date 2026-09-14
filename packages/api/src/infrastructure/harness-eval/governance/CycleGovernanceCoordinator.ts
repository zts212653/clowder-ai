import type { CycleGovernanceSubmission, CycleRecord, HarnessGovernanceProposal } from '@cat-cafe/shared';
import { CycleEvaluationCoordinator, type CycleEvaluationPrincipal } from '../evaluation/CycleEvaluationCoordinator.js';
import { adaptCycleTriggerPolicy, cycleTriggerPolicyFor } from '../evaluation/cycle-trigger-policy.js';
import type { ObjectiveEvaluationRuntime } from '../evaluation/ObjectiveEvaluationRuntime.js';
import { counterexampleWakeKey } from '../trace-annotation/high-confidence-annotation.js';
import {
  buildGovernanceAssignment,
  formatGovernanceAssignment,
  MAX_GOVERNANCE_ASSIGNMENT_BYTES,
} from './CycleGovernanceContent.js';
import { CycleGovernanceProposalDecisions } from './CycleGovernanceProposalDecisions.js';
import type { HarnessGovernanceExecutor } from './HarnessGovernanceExecutor.js';
import { type HarnessGovernanceProposalStore, harnessGovernanceProposalId } from './HarnessGovernanceProposalStore.js';

export const GOVERNANCE_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class CycleGovernanceCoordinator {
  private readonly now: () => number;
  private readonly decisions: CycleGovernanceProposalDecisions;

  constructor(
    private readonly deps: {
      runtime: ObjectiveEvaluationRuntime;
      evaluation: CycleEvaluationCoordinator;
      proposals: HarnessGovernanceProposalStore;
      executor: HarnessGovernanceExecutor;
      isThreadQuiescent: (threadId: string, ownerUserId: string) => Promise<boolean>;
      notifyProposal?: (
        ownerUserId: string,
        proposalId: string,
        status: 'pending' | 'approved' | 'skipped' | 'rejected',
      ) => void;
      now?: () => number;
      log?: { warn: (value: unknown, message?: string) => void };
    },
  ) {
    this.now = deps.now ?? Date.now;
    this.decisions = new CycleGovernanceProposalDecisions({
      runtime: deps.runtime,
      evaluation: deps.evaluation,
      proposals: deps.proposals,
      executor: deps.executor,
      notify: deps.notifyProposal,
      now: this.now,
    });
    deps.evaluation.setWrittenHandler((record) => this.ensureAssignment(record));
  }

  async ensureAssignment(record: CycleRecord): Promise<void> {
    if (
      record.evalStatus !== 'written' ||
      !record.evaluation ||
      record.evaluation.overall === 'insufficient_evidence' ||
      record.governance ||
      record.governanceAssignedAt !== undefined
    ) {
      return;
    }
    const history = await this.deps.runtime.cycles.history(record.ownerUserId, record.objectiveId, 8);
    const assignment = buildGovernanceAssignment(this.deps.runtime.catalog, record, history);
    const content = formatGovernanceAssignment(record, assignment);
    if (Buffer.byteLength(content) > MAX_GOVERNANCE_ASSIGNMENT_BYTES) {
      throw new Error('cycle_governance_assignment_exceeds_limit');
    }
    const thread = await this.deps.evaluation.ensureObjectiveThread(record.objectiveId, record.ownerUserId);
    const messageId = await this.deps.evaluation.deliverAndWake(
      record,
      thread.threadId,
      thread.catId,
      content,
      'governance-assignment',
    );
    const current = await this.deps.runtime.cycles.current(record.ownerUserId, record.objectiveId);
    if (!current || current.cycleId !== record.cycleId || current.evalStatus !== 'written' || current.governance)
      return;
    await this.deps.runtime.cycles.transition(current, {
      ...current,
      governanceAssignmentMessageId: messageId,
      governanceAssignedAt: this.now(),
    });
  }

  async reconcileKnownCycles(now: number): Promise<void> {
    for (const ownerUserId of await this.deps.runtime.cycles.ownerUserIds()) {
      for (const objective of this.deps.runtime.catalog.registry.objectives.filter(
        (candidate) => candidate.lifecycle !== 'retired',
      )) {
        try {
          await this.reconcileCycle(ownerUserId, objective.id, now);
        } catch (error) {
          this.deps.log?.warn(
            { err: error, ownerUserId, objectiveId: objective.id },
            '[F257] governance reconciliation failed',
          );
        }
      }
    }
  }

  async submitGovernance(principal: CycleEvaluationPrincipal, input: CycleGovernanceSubmission) {
    const record = await this.findSubmissionCycle(principal, input.objectiveId, input.cycleId);
    const existing = existingSubmission(record, input);
    if (existing) return existing;
    if (
      record.evalStatus !== 'written' ||
      !record.evaluation ||
      record.evaluation.overall === 'insufficient_evidence'
    ) {
      throw new Error(`cycle_governance_not_active:${record.cycleId}`);
    }
    const reason = input.reason.trim();
    if (!reason) throw new Error('cycle_governance_reason_required');
    const writtenAt = this.now();
    if (input.decision === 'keep') return this.keep(record, input, reason, writtenAt, principal.catId);

    const history = await this.deps.runtime.cycles.history(record.ownerUserId, record.objectiveId, 8);
    const assignment = buildGovernanceAssignment(this.deps.runtime.catalog, record, history);
    const changes = await this.deps.executor.hydrate(record.objectiveId, { ...input, reason });
    const triggerCounts = await this.triggerCounts(record);
    const cardOrdinal = (record.approval?.rejectCount ?? 0) + 1;
    const proposal: HarnessGovernanceProposal = {
      schemaVersion: 1,
      proposalId: harnessGovernanceProposalId(record.cycleId, cardOrdinal),
      ownerUserId: record.ownerUserId,
      objective: structuredClone(assignment.objective),
      objectiveId: record.objectiveId,
      cycleId: record.cycleId,
      threadId: CycleEvaluationCoordinator.threadIdFor(record.objectiveId),
      cardOrdinal,
      decision: input.decision,
      status: 'pending',
      reason,
      version: record.version,
      versionContentRef: record.versionContentRef,
      windows: record.windows.map((window) => ({ ...window })),
      triggeredBy: [...(record.triggeredBy ?? [])],
      triggerCounts,
      evaluation: structuredClone(assignment.evaluation),
      history: structuredClone(assignment.history),
      rejectReasons: [...assignment.rejectedProposalReasons],
      changes,
      evidenceRefs: uniqueEvidenceRefs(record),
      createdAt: writtenAt,
    };
    await this.deps.proposals.create(proposal);
    const replacement: CycleRecord = {
      ...record,
      governance: { decision: input.decision, reason, writtenAt, by: principal.catId },
      approval: {
        cardId: proposal.proposalId,
        state: 'pending',
        rejectCount: record.approval?.rejectCount ?? 0,
        at: writtenAt,
      },
    };
    if (!(await this.deps.runtime.cycles.transition(record, replacement))) {
      const concurrent = await this.deps.runtime.cycles.current(record.ownerUserId, record.objectiveId);
      if (!concurrent || !sameGovernance(concurrent, input)) {
        throw new Error(`cycle_governance_conflict:${record.cycleId}`);
      }
    }
    this.notify(record.ownerUserId, proposal.proposalId, 'pending');
    return { outcome: 'written', cycleId: record.cycleId, decision: input.decision, proposalId: proposal.proposalId };
  }

  async approveProposal(ownerUserId: string, proposalId: string, actorId: string, reason: string) {
    return this.decisions.approve(ownerUserId, proposalId, actorId, reason);
  }

  async skipProposal(ownerUserId: string, proposalId: string, actorId: string, reason?: string) {
    return this.decisions.skip(ownerUserId, proposalId, actorId, reason);
  }

  async rejectProposal(ownerUserId: string, proposalId: string, actorId: string, reason: string) {
    return this.decisions.reject(ownerUserId, proposalId, actorId, reason);
  }

  private async keep(
    record: CycleRecord,
    input: CycleGovernanceSubmission,
    reason: string,
    writtenAt: number,
    by: string,
  ) {
    await this.deps.executor.hydrate(record.objectiveId, { ...input, reason });
    const adaptation = adaptCycleTriggerPolicy(this.deps.runtime.catalog, record, 'keep', writtenAt);
    const completed: CycleRecord = {
      ...record,
      governance: { decision: 'keep', reason, writtenAt, by },
      triggerPolicyChange: adaptation.change,
      objectiveLifecycle: adaptation.lifecycle,
      closedAt: writtenAt,
    };
    const version = await this.deps.executor.currentVersion(record.objectiveId, {
      triggerPolicy: adaptation.change.after,
      lifecycle: adaptation.lifecycle,
    });
    const next = await this.deps.runtime.cycles.advance(record, completed, version);
    if (!next) throw new Error(`cycle_governance_conflict:${record.cycleId}`);
    return { outcome: 'written', cycleId: record.cycleId, decision: 'keep' as const, nextCycleId: next.cycleId };
  }

  private async triggerCounts(record: CycleRecord) {
    const objective = this.deps.runtime.catalog.registry.objectives.find((item) => item.id === record.objectiveId);
    const model = this.deps.runtime.catalog.registry.evaluationModels.find(
      (item) => item.id === objective?.evaluationModelId,
    );
    if (!model) throw new Error(`cycle_evaluation_model_not_found:${record.objectiveId}`);
    const policy = cycleTriggerPolicyFor(this.deps.runtime.catalog, record);
    const [invocationIds, annotationLists] = await Promise.all([
      this.deps.runtime.traces.ownerInvocationIds(record.ownerUserId, record.windows),
      Promise.all(
        record.windows.flatMap((window) =>
          model.metrics.map((metric) =>
            this.deps.runtime.annotations.queryMetricWindow(
              record.ownerUserId,
              record.objectiveId,
              metric.id,
              window.start,
              window.end,
            ),
          ),
        ),
      ),
    ]);
    const counterexamples = new Set(
      annotationLists
        .flat()
        .map((annotation) => counterexampleWakeKey(annotation))
        .filter((key): key is string => key !== null),
    );
    return {
      cumulative: { count: invocationIds.length, threshold: policy.cumulativeThreshold },
      counterexamples: { count: counterexamples.size, threshold: policy.counterexampleThreshold },
    };
  }

  private async reconcileCycle(ownerUserId: string, objectiveId: string, now: number): Promise<void> {
    let record = await this.deps.runtime.cycles.current(ownerUserId, objectiveId);
    if (
      !record ||
      record.evalStatus !== 'written' ||
      !record.evaluation ||
      record.evaluation.overall === 'insufficient_evidence'
    ) {
      return;
    }
    if (!record.governance && record.governanceAssignedAt === undefined) {
      await this.ensureAssignment(record);
      record = (await this.deps.runtime.cycles.current(ownerUserId, objectiveId)) ?? record;
    }
    const hasProposal = record.approval?.cardId
      ? Boolean(await this.deps.proposals.get(record.approval.cardId))
      : false;
    if (hasProposal || !record.governanceAssignedAt || !this.reminderDue(record, now)) return;
    const threadId = CycleEvaluationCoordinator.threadIdFor(objectiveId);
    if (!(await this.deps.isThreadQuiescent(threadId, ownerUserId))) return;
    const thread = await this.deps.evaluation.ensureObjectiveThread(objectiveId, ownerUserId);
    const day = Math.floor(now / GOVERNANCE_REMINDER_INTERVAL_MS);
    const messageId = await this.deps.evaluation.deliverAndWake(
      record,
      thread.threadId,
      thread.catId,
      [
        '## F257 Governance Card Missing',
        '',
        `Cycle \`${record.cycleId}\` has a written evaluation but no expected proposal card.`,
        'Submit structured governance now. keep closes the cycle; rollback/evolve must produce a proposal card.',
      ].join('\n'),
      `governance-reminder-${day}`,
    );
    const current = await this.deps.runtime.cycles.current(ownerUserId, objectiveId);
    if (current?.cycleId === record.cycleId && current.evalStatus === 'written') {
      await this.deps.runtime.cycles.transition(current, {
        ...current,
        governanceReminderMessageId: messageId,
        governanceRemindedAt: now,
      });
    }
  }

  private reminderDue(record: CycleRecord, now: number): boolean {
    return (
      record.governanceRemindedAt === undefined || now >= record.governanceRemindedAt + GOVERNANCE_REMINDER_INTERVAL_MS
    );
  }

  private async findSubmissionCycle(
    principal: CycleEvaluationPrincipal,
    objectiveId: string,
    cycleId: string,
  ): Promise<CycleRecord> {
    if (principal.threadId !== CycleEvaluationCoordinator.threadIdFor(objectiveId)) {
      throw new Error(`cycle_governance_principal_mismatch:${cycleId}`);
    }
    const current = await this.deps.runtime.cycles.current(principal.userId, objectiveId);
    if (current?.cycleId === cycleId) return current;
    const history = await this.deps.runtime.cycles.historyCycle(principal.userId, objectiveId, cycleId);
    if (history) return history;
    throw new Error(`cycle_governance_not_found:${cycleId}`);
  }

  private notify(
    ownerUserId: string,
    proposalId: string,
    status: 'pending' | 'approved' | 'skipped' | 'rejected',
  ): void {
    try {
      this.deps.notifyProposal?.(ownerUserId, proposalId, status);
    } catch {
      /* websocket projection is best-effort after durable state */
    }
  }
}

function sameGovernance(record: CycleRecord, input: CycleGovernanceSubmission): boolean {
  return record.governance?.decision === input.decision && record.governance.reason === input.reason.trim();
}

function existingSubmission(record: CycleRecord, input: CycleGovernanceSubmission) {
  if (!record.governance) return null;
  if (!sameGovernance(record, input)) throw new Error(`cycle_governance_conflict:${record.cycleId}`);
  return {
    outcome: 'already_written' as const,
    cycleId: record.cycleId,
    decision: record.governance.decision,
    ...(record.approval?.cardId ? { proposalId: record.approval.cardId } : {}),
  };
}

function uniqueEvidenceRefs(record: CycleRecord): string[] {
  return [
    ...new Set([
      ...(record.evaluation?.metrics.flatMap((metric) => metric.evidenceRefs) ?? []),
      ...(record.evaluation?.coverageAssessment?.findings.flatMap((finding) => finding.evidenceRefs) ?? []),
    ]),
  ].slice(0, 64);
}
