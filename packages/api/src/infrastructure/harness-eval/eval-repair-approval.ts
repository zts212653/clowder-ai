import {
  type ApprovalOriginRef,
  createCatId,
  exactAssetVersionRefV1Schema,
  ownerTruthRefV1Schema,
} from '@cat-cafe/shared';
import {
  appendEvalRepairEvent,
  buildEvalRepairApprovalCard,
  classifyDrift,
  deriveProposalId,
  deriveRequestIdempotencyRef,
  type EvalRepairApprovalServiceOptions,
  type EvalRepairAuthenticatedPrincipal,
  type EvalRepairCaseAction,
  type EvalRepairDecisionReason,
  type EvalRepairDecisionResult,
  type EvalRepairMaterializeResult,
  type EvalRepairOwnerResolution,
  type EvalRepairProposeResult,
  locateEvalRepairApproval,
  requireNonEmpty,
  snapshot,
  validatePrincipal,
} from './eval-repair-approval-contracts.js';
import { EvalRepairApprovalPublicationStore, projectEvalRepairApprovals } from './eval-repair-approval-projection.js';
import { materializeEvalRepairApproval } from './eval-repair-materialization.js';
import { supersedeEvalRepairApproval } from './eval-repair-supersession.js';
import type { EvalLifecycleEvent } from './reeval-closure-schema.js';

export { approvalEnvelopeRef } from './eval-repair-approval-contracts.js';
export class EvalRepairApprovalService {
  private readonly now: () => string;
  private readonly publicationStore: EvalRepairApprovalPublicationStore;
  private readonly inFlightMaterialization = new Map<string, Promise<EvalRepairMaterializeResult>>();
  constructor(private readonly options: EvalRepairApprovalServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.publicationStore = new EvalRepairApprovalPublicationStore(options.eventLog);
  }
  async propose(input: {
    caseActionRef: string;
    clientMessageId: string;
    principal: EvalRepairAuthenticatedPrincipal;
  }): Promise<EvalRepairProposeResult> {
    requireNonEmpty(input.caseActionRef, 'caseActionRef');
    requireNonEmpty(input.clientMessageId, 'clientMessageId');
    validatePrincipal(input.principal);
    const permit = await this.options.epochAuthority.authorize('F266', 'v1', 'proposal_ingress');
    if (!permit.allowed) return { status: 'blocked', reason: 'approval_lifecycle_unavailable' };
    const action = await this.options.resolveCaseAction(input.caseActionRef);
    if (!action) return { status: 'blocked', reason: 'case_action_not_found' };
    if (action.approvalRequirement.kind === 'not_required') {
      if (action.analysisDisposition === 'repair') throw new Error('repair case cannot bypass Approval');
      return { status: 'not_required', disposition: action.analysisDisposition };
    }
    const owner = await this.resolveOwner(action);
    if (owner.status === 'blocked') return { status: 'blocked', reason: owner.reason };
    const proposalId = deriveProposalId(action, owner);
    const projection = projectEvalRepairApprovals(await this.options.eventLog.read(action.caseId));
    const existing = projection.proposals.find((candidate) => candidate.proposal.proposalId === proposalId);
    const recoveredSupersession = projection.proposals.find(
      (candidate) => candidate.proposal.caseActionRef === input.caseActionRef && candidate.supersededByCaseActionRef,
    );
    if (recoveredSupersession?.supersededByCaseActionRef) {
      return {
        status: 'superseded',
        freshCaseActionRef: recoveredSupersession.supersededByCaseActionRef,
        ...(recoveredSupersession.supersessionDrift ? { drift: recoveredSupersession.supersessionDrift } : {}),
      };
    }
    if (existing?.publication.state === 'anchored') {
      return {
        status: 'published',
        proposalId,
        approvalPublicationRef: `approval-envelope:F266:${proposalId}`,
      };
    }
    const superseded = await this.supersedeDriftedProposal(action.caseId, proposalId, input.caseActionRef, owner);
    if (superseded) return superseded;
    if (!existing) {
      const occurredAt = this.now();
      const event: EvalLifecycleEvent = {
        eventId: `f266:${action.caseId}:proposal:${proposalId}`,
        caseId: action.caseId,
        verdictId: action.verdictId,
        domainId: action.domainId,
        type: 'approval_proposed',
        actor: { kind: 'cat', id: input.principal.catId },
        occurredAt,
        reason: 'authenticated invocation requested owner-backed authority for an exact repair target',
        refs: [
          { kind: 'other', availability: 'available', value: action.findingArtifactRef },
          { kind: 'message', availability: 'available', value: `message:${input.principal.originMessageId}` },
        ],
        proposalId,
        caseActionRef: input.caseActionRef,
        requestIdempotencyRef: deriveRequestIdempotencyRef(input.principal, input.clientMessageId, input.caseActionRef),
        requestedAuthority: action.approvalRequirement.reason,
        findingArtifactRef: action.findingArtifactRef,
        expectedChange: action.expectedChange,
        costAndRollback: action.costAndRollback,
        withdrawalCondition: action.withdrawalCondition,
        summary: `Eval repair · ${action.findingKey}`,
        detail: {
          expectedChange: action.expectedChange,
          costAndRollback: action.costAndRollback,
          withdrawalCondition: action.withdrawalCondition,
          ownerRef: owner.ownerRef,
          ownerAuthorizationRef: owner.ownerAuthorizationRef,
          targetVersionRef: owner.targetVersionRef,
        },
        requestOrigin: {
          invocationId: input.principal.invocationId,
          threadId: input.principal.threadId,
          messageId: input.principal.originMessageId,
          requesterCatId: input.principal.catId,
          ownerUserId: input.principal.userId,
        },
        requestSnapshot: snapshot(owner),
        ...(action.supersedesProposalId ? { supersedesProposalId: action.supersedesProposalId } : {}),
      };
      await appendEvalRepairEvent(this.options.eventLog, action.caseId, event);
    }
    const canonical = await locateEvalRepairApproval(this.options.eventLog, proposalId);
    if (!canonical) throw new Error(`canonical Approval proposal disappeared: ${proposalId}`);
    const proposed = canonical.record.proposal;
    const originRef: ApprovalOriginRef = {
      kind: 'message',
      threadId: proposed.requestOrigin.threadId,
      messageId: proposed.requestOrigin.messageId,
    };
    await this.options.approvalIngress.publish(
      {
        producerId: 'F266',
        canonicalProposalId: proposalId,
        ownerUserId: proposed.requestOrigin.ownerUserId,
        requesterCatId: createCatId(proposed.requestOrigin.requesterCatId),
        originRef,
        cardThreadId: proposed.requestOrigin.threadId,
        cardContent: `Approval required for ${proposed.summary}`,
        cardBlock: buildEvalRepairApprovalCard({
          proposalId,
          summary: proposed.summary,
          expectedChange: proposed.expectedChange,
          costAndRollback: proposed.costAndRollback,
          withdrawalCondition: proposed.withdrawalCondition,
          targetVersionRef: proposed.requestSnapshot.targetVersionRef,
        }),
        createdAt: Date.parse(proposed.occurredAt),
      },
      this.publicationStore,
    );
    return {
      status: 'published',
      proposalId,
      approvalPublicationRef: `approval-envelope:F266:${proposalId}`,
    };
  }
  async decide(input: {
    proposalId: string;
    decision: 'accept' | 'reject' | 'withdraw';
    reasonCode: EvalRepairDecisionReason;
    reasonText?: string;
    decidedByUserId: string;
  }): Promise<EvalRepairDecisionResult> {
    const permit = await this.options.epochAuthority.authorize('F266', 'v1', 'decision');
    if (!permit.allowed) return { status: 'blocked', reason: 'approval_lifecycle_unavailable' };
    const located = await locateEvalRepairApproval(this.options.eventLog, input.proposalId);
    if (!located) return { status: 'blocked', reason: 'proposal_not_found' };
    if (located.record.proposal.requestOrigin.ownerUserId !== input.decidedByUserId) {
      throw new Error('Approval decision principal does not own this proposal');
    }
    if (located.record.publication.state !== 'anchored') return { status: 'blocked', reason: 'approval_not_anchored' };
    if (located.record.lifecycle.resolution !== 'open') {
      return { status: 'duplicate', resolution: located.record.lifecycle.resolution };
    }
    const resolution =
      input.decision === 'accept'
        ? ('accepted' as const)
        : input.decision === 'reject'
          ? ('rejected' as const)
          : ('closed_without_decision' as const);
    const occurredAt = this.now();
    const approvalRef = ownerTruthRefV1Schema.parse({
      ownerFeatureId: 'F246',
      ownerStateRef: `approval:F266:${input.proposalId}:${resolution}`,
      version: occurredAt,
    });
    await appendEvalRepairEvent(this.options.eventLog, located.caseId, {
      eventId: `f266:${located.caseId}:proposal:${input.proposalId}:decision`,
      caseId: located.caseId,
      verdictId: located.record.proposal.verdictId,
      domainId: located.record.proposal.domainId,
      type: 'approval_decided',
      actor: { kind: 'cvo', id: input.decidedByUserId },
      occurredAt,
      reason: input.reasonText ?? input.reasonCode,
      refs: [{ kind: 'other', availability: 'available', value: approvalRef.ownerStateRef }],
      proposalId: input.proposalId,
      resolution,
      decisionKind: input.decision,
      reasonCode: input.reasonCode,
      ...(input.reasonText ? { reasonText: input.reasonText } : {}),
      decidedByUserId: input.decidedByUserId,
      approvalRef,
      requestSnapshot: located.record.proposal.requestSnapshot,
    });
    const committed = await locateEvalRepairApproval(this.options.eventLog, input.proposalId);
    if (!committed?.record.decision) throw new Error('canonical Approval decision did not persist');
    return committed.record.decision.decisionKind === input.decision
      ? { status: committed.record.decision.resolution }
      : { status: 'duplicate', resolution: committed.record.decision.resolution };
  }
  materialize(proposalId: string): Promise<EvalRepairMaterializeResult> {
    const existing = this.inFlightMaterialization.get(proposalId);
    if (existing) return existing;
    const pending = this.materializeOnce(proposalId).finally(() => {
      if (this.inFlightMaterialization.get(proposalId) === pending) this.inFlightMaterialization.delete(proposalId);
    });
    this.inFlightMaterialization.set(proposalId, pending);
    return pending;
  }
  private async materializeOnce(proposalId: string): Promise<EvalRepairMaterializeResult> {
    return materializeEvalRepairApproval({
      options: this.options,
      now: this.now,
      proposalId,
      resolveOwner: (action) => this.resolveOwner(action, true),
    });
  }
  private async resolveOwner(
    action: EvalRepairCaseAction,
    allowTargetDrift = false,
  ): Promise<EvalRepairOwnerResolution> {
    const result = await this.options.resolveOwnerChangeContract({
      caseId: action.caseId,
      verdictId: action.verdictId,
      featureId: action.repairTarget.featureId,
      ...(action.repairTarget.componentId ? { componentId: action.repairTarget.componentId } : {}),
      expectedTargetVersion: action.repairTarget.version,
    });
    if (result.status === 'blocked') {
      ownerTruthRefV1Schema.parse(result.blockerRef);
      return result;
    }
    const parsed = {
      status: 'resolved' as const,
      ownerRef: ownerTruthRefV1Schema.parse(result.ownerRef),
      ownerAuthorizationRef: ownerTruthRefV1Schema.parse(result.ownerAuthorizationRef),
      targetVersionRef: exactAssetVersionRefV1Schema.parse(result.targetVersionRef),
      dispatchRef: ownerTruthRefV1Schema.parse(result.dispatchRef),
    };
    if (!allowTargetDrift && parsed.targetVersionRef.version !== action.repairTarget.version) {
      return {
        status: 'blocked',
        reason: 'target_version_mismatch',
        blockerRef: ownerTruthRefV1Schema.parse({
          ownerFeatureId: action.repairTarget.featureId,
          ownerStateRef: `blocker:target-version-mismatch:${action.caseId}`,
        }),
      };
    }
    return parsed;
  }

  private async supersedeDriftedProposal(
    caseId: string,
    proposalId: string,
    caseActionRef: string,
    owner: Extract<EvalRepairOwnerResolution, { status: 'resolved' }>,
  ): Promise<Extract<EvalRepairProposeResult, { status: 'superseded' | 'blocked' }> | undefined> {
    const projection = projectEvalRepairApprovals(await this.options.eventLog.read(caseId));
    const active = projection.active;
    if (!active || active.proposal.proposalId === proposalId) return undefined;
    if (active.proposal.caseActionRef !== caseActionRef) {
      return { status: 'superseded', freshCaseActionRef: active.proposal.caseActionRef };
    }
    const drift = classifyDrift(active.proposal.requestSnapshot, owner);
    if (!drift) throw new Error('one case/action resolved to conflicting immutable proposal identities');
    const superseded = await supersedeEvalRepairApproval({
      eventLog: this.options.eventLog,
      caseId,
      proposalId: active.proposal.proposalId,
      owner,
      drift,
      occurredAt: this.now(),
    });
    if (superseded.status === 'superseded') return superseded;
    if (superseded.status === 'materialization_in_progress') {
      return { status: 'blocked', reason: 'approval_materialization_in_progress' };
    }
    if (superseded.status === 'materialized') {
      return { status: 'blocked', reason: 'approval_already_materialized' };
    }
    return undefined;
  }
}
