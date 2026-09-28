import { type ExactAssetVersionRefV1, type OwnerTruthRefV1 } from '@cat-cafe/shared';
import type { EvalReleaseTruthResolver } from '../../harness-eval/eval-release-truth-resolver.js';
import { locateEvalRepairApproval } from '../../harness-eval/eval-repair-approval-contracts.js';
import type {
  EvalRepairBoundRefs,
  EvalRepairFreshOutcomeReceipt,
  EvalRepairInterventionReceipt,
} from '../../harness-eval/eval-repair-outcome-contracts.js';
import type { IReevalClosureEventLog } from '../../harness-eval/reeval-closure-event-log.js';
import { isRequestReviewAssetVersionRef } from '../adapters/request-review/request-review-owner-identity.js';
import type {
  RequestReviewOwnerEvent,
  RequestReviewOwnerLedger,
} from '../adapters/request-review/request-review-owner-ledger-contract.js';
import type { RequestReviewLineageBindingResolver } from './request-review-lineage-binding-resolver.js';
import { boundRefs, digest, ownerRef, sameRef, validTime } from './request-review-owner-receipt-support.js';

interface ReceiptServiceOptions {
  eventLog: IReevalClosureEventLog;
  ledger: RequestReviewOwnerLedger;
  lineageBindingResolver: Pick<RequestReviewLineageBindingResolver, 'resolveProposalScope'>;
  versionVerifier: {
    verifyCommitVersion(commitSha: string, versionRef: ExactAssetVersionRefV1): Promise<boolean>;
    verifyAllowedTransition(
      previousVersionRef: ExactAssetVersionRefV1,
      commitSha: string,
      nextVersionRef: ExactAssetVersionRefV1,
    ): Promise<boolean>;
    isKnownVersion(versionRef: ExactAssetVersionRefV1): Promise<boolean>;
  };
  releaseTruth: Pick<EvalReleaseTruthResolver, 'loadedRuntimeHead' | 'verifyMainLanded' | 'verifyLiveActive'>;
  now?: () => string;
}

type Blocked = { status: 'blocked'; reason: string };
type Recorded = { status: 'recorded' | 'duplicate'; receiptRef: OwnerTruthRefV1 };

type Located = NonNullable<Awaited<ReturnType<typeof locateEvalRepairApproval>>>;

export class RequestReviewOwnerReceiptService {
  private readonly now: () => string;

  constructor(private readonly options: ReceiptServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private async binding(proposalId: string): Promise<{ located: Located; refs: EvalRepairBoundRefs } | Blocked> {
    const located = await locateEvalRepairApproval(this.options.eventLog, proposalId);
    if (!located) return { status: 'blocked', reason: 'proposal_not_found' };
    if (located.record.lifecycle.resolution !== 'accepted') {
      return { status: 'blocked', reason: 'approval_not_accepted' };
    }
    if (located.record.supersededByCaseActionRef) return { status: 'blocked', reason: 'approval_superseded' };
    if (!located.record.materialization) return { status: 'blocked', reason: 'approval_not_materialized' };
    const scope = await this.options.lineageBindingResolver.resolveProposalScope({
      caseId: located.caseId,
      proposal: located.record.proposal,
    });
    if (scope.status === 'blocked') return { status: 'blocked', reason: 'binding_missing' };
    const refs = boundRefs(located);
    if (!refs || !isRequestReviewAssetVersionRef(refs.targetVersionRef)) {
      return { status: 'blocked', reason: 'binding_missing' };
    }
    return { located, refs };
  }

  private releaseVerified(mainCommitSha: string, loadedRuntimeRef: OwnerTruthRefV1): string | undefined {
    try {
      const main = this.options.releaseTruth.verifyMainLanded(mainCommitSha);
      if (main.commitSha !== mainCommitSha) return 'main_not_landed';
    } catch {
      return 'main_not_landed';
    }
    try {
      const live = this.options.releaseTruth.verifyLiveActive(mainCommitSha);
      if (live.commitSha !== mainCommitSha) return 'live_not_active';
    } catch {
      return 'live_not_active';
    }
    return this.options.releaseTruth.loadedRuntimeHead &&
      loadedRuntimeRef.version === this.options.releaseTruth.loadedRuntimeHead
      ? undefined
      : 'loaded_runtime_mismatch';
  }

  private async appendReceipt(
    event: RequestReviewOwnerEvent,
    receiptRef: OwnerTruthRefV1,
  ): Promise<Recorded | Blocked> {
    const result = await this.options.ledger.append(event);
    if (result.outcome === 'idempotency_collision') return { status: 'blocked', reason: result.outcome };
    return { status: result.outcome === 'duplicate' ? 'duplicate' : 'recorded', receiptRef };
  }

  async recordChanged(input: {
    proposalId: string;
    assetVersionRef: ExactAssetVersionRefV1;
    mainCommitSha: string;
    loadedRuntimeRef: OwnerTruthRefV1;
    changedAt: string;
    loadedAt: string;
  }): Promise<Recorded | Blocked> {
    const binding = await this.binding(input.proposalId);
    if ('status' in binding) return binding;
    if (
      !isRequestReviewAssetVersionRef(input.assetVersionRef) ||
      sameRef(input.assetVersionRef, binding.refs.targetVersionRef) ||
      !(await this.options.versionVerifier.verifyCommitVersion(input.mainCommitSha, input.assetVersionRef))
    ) {
      return { status: 'blocked', reason: 'asset_version_unverified' };
    }
    if (
      !(await this.options.versionVerifier.verifyAllowedTransition(
        binding.refs.targetVersionRef,
        input.mainCommitSha,
        input.assetVersionRef,
      ))
    ) {
      return { status: 'blocked', reason: 'asset_transition_unverified' };
    }
    const decisionAt = validTime(binding.located.record.decidedAt ?? '');
    const changedAt = validTime(input.changedAt);
    const loadedAt = validTime(input.loadedAt);
    if (!decisionAt || !changedAt || !loadedAt || changedAt < decisionAt || loadedAt < changedAt) {
      return { status: 'blocked', reason: 'invalid_receipt_time' };
    }
    const releaseBlock = this.releaseVerified(input.mainCommitSha, input.loadedRuntimeRef);
    if (releaseBlock) return { status: 'blocked', reason: releaseBlock };
    const receiptRef = ownerRef('intervention', input);
    return this.appendReceipt(
      {
        schemaVersion: 1,
        eventId: `intervention:${input.proposalId}`,
        type: 'intervention_changed',
        occurredAt: this.now(),
        proposalId: input.proposalId,
        receiptRef,
        assetVersionRef: input.assetVersionRef,
        mainCommitSha: input.mainCommitSha,
        loadedRuntimeRef: input.loadedRuntimeRef,
        changedAt: input.changedAt,
        loadedAt: input.loadedAt,
      },
      receiptRef,
    );
  }

  async recordNoChange(input: {
    proposalId: string;
    reasonCode: 'evidence_already_satisfied' | 'risk_exceeds_benefit' | 'target_retired' | 'blocked_external' | 'other';
    withdrawalCondition: string;
    nextEvalAt: string;
    recordedAt: string;
  }): Promise<Recorded | Blocked> {
    const binding = await this.binding(input.proposalId);
    if ('status' in binding) return binding;
    const recordedAt = validTime(input.recordedAt);
    const nextEvalAt = validTime(input.nextEvalAt);
    const decisionAt = validTime(binding.located.record.decidedAt ?? '');
    if (!decisionAt || !recordedAt || !nextEvalAt || recordedAt < decisionAt || nextEvalAt <= recordedAt) {
      return { status: 'blocked', reason: 'invalid_receipt_time' };
    }
    const receiptRef = ownerRef('intervention', input);
    return this.appendReceipt(
      {
        schemaVersion: 1,
        eventId: `intervention:${input.proposalId}`,
        occurredAt: this.now(),
        ...input,
        type: 'intervention_no_change',
        receiptRef,
      },
      receiptRef,
    );
  }

  async linkEvidence(input: {
    proposalId: string;
    assetVersionRef: ExactAssetVersionRefV1;
    role: 'comparison_baseline' | 'candidate_independent_verification' | 'post_adoption_observation';
    evidenceRef: OwnerTruthRefV1;
    proofRef: OwnerTruthRefV1;
    status: 'verified' | 'insufficient';
    label?: string;
  }): Promise<{ status: 'recorded' | 'duplicate' } | Blocked> {
    const binding = await this.binding(input.proposalId);
    if ('status' in binding) return binding;
    if (
      !isRequestReviewAssetVersionRef(input.assetVersionRef) ||
      !(await this.options.versionVerifier.isKnownVersion(input.assetVersionRef))
    ) {
      return { status: 'blocked', reason: 'asset_version_unverified' };
    }
    const event: RequestReviewOwnerEvent = {
      schemaVersion: 1,
      eventId: `evidence:${digest(input)}`,
      occurredAt: this.now(),
      ...input,
      type: 'evidence_linked',
    };
    const result = await this.options.ledger.append(event);
    return result.outcome === 'idempotency_collision'
      ? { status: 'blocked', reason: result.outcome }
      : { status: result.outcome === 'duplicate' ? 'duplicate' : 'recorded' };
  }

  async recordFreshOutcome(input: {
    proposalId: string;
    interventionReceiptRef: OwnerTruthRefV1;
    reevaluationRef: OwnerTruthRefV1;
    freshnessProofRef: OwnerTruthRefV1;
    outcome: EvalRepairFreshOutcomeReceipt['outcome'];
    loadedRuntimeRef?: OwnerTruthRefV1;
    measuredAt: string;
    uncontaminated: boolean;
  }): Promise<Recorded | Blocked> {
    const binding = await this.binding(input.proposalId);
    if ('status' in binding) return binding;
    const events = await this.options.ledger.read();
    const intervention = events.find(
      (event) =>
        (event.type === 'intervention_changed' || event.type === 'intervention_no_change') &&
        event.proposalId === input.proposalId &&
        sameRef(event.receiptRef, input.interventionReceiptRef),
    );
    if (
      !intervention ||
      (intervention.type !== 'intervention_changed' && intervention.type !== 'intervention_no_change')
    ) {
      return { status: 'blocked', reason: 'intervention_receipt_missing' };
    }
    const interventionAt =
      intervention.type === 'intervention_changed'
        ? validTime(intervention.loadedAt)
        : validTime(intervention.recordedAt);
    const measuredAt = validTime(input.measuredAt);
    if (!interventionAt || !measuredAt || measuredAt <= interventionAt) {
      return { status: 'blocked', reason: 'invalid_receipt_time' };
    }
    const receiptRef = ownerRef('fresh-outcome', input);
    return this.appendReceipt(
      {
        schemaVersion: 1,
        eventId: `fresh-outcome:${input.proposalId}`,
        occurredAt: this.now(),
        ...input,
        type: 'fresh_outcome_recorded',
        receiptRef,
      },
      receiptRef,
    );
  }

  async recordRollback(input: {
    proposalId: string;
    interventionReceiptRef: OwnerTruthRefV1;
    restoredVersionRef: ExactAssetVersionRefV1;
    mainCommitSha: string;
    loadedRuntimeRef: OwnerTruthRefV1;
    restoredAt: string;
    loadedAt: string;
  }): Promise<Recorded | Blocked> {
    const binding = await this.binding(input.proposalId);
    if ('status' in binding) return binding;
    const intervention = (await this.options.ledger.read()).find(
      (event) =>
        event.type === 'intervention_changed' &&
        event.proposalId === input.proposalId &&
        sameRef(event.receiptRef, input.interventionReceiptRef),
    );
    if (!intervention || intervention.type !== 'intervention_changed') {
      return { status: 'blocked', reason: 'intervention_receipt_missing' };
    }
    if (!sameRef(input.restoredVersionRef, binding.refs.targetVersionRef)) {
      return { status: 'blocked', reason: 'rollback_target_mismatch' };
    }
    if (
      !isRequestReviewAssetVersionRef(input.restoredVersionRef) ||
      !(await this.options.versionVerifier.verifyCommitVersion(input.mainCommitSha, input.restoredVersionRef))
    ) {
      return { status: 'blocked', reason: 'asset_version_unverified' };
    }
    if (
      !(await this.options.versionVerifier.verifyAllowedTransition(
        intervention.assetVersionRef,
        input.mainCommitSha,
        input.restoredVersionRef,
      ))
    ) {
      return { status: 'blocked', reason: 'asset_transition_unverified' };
    }
    const restoredAt = validTime(input.restoredAt);
    const loadedAt = validTime(input.loadedAt);
    const interventionLoadedAt = validTime(intervention.loadedAt);
    if (
      !interventionLoadedAt ||
      !restoredAt ||
      !loadedAt ||
      restoredAt <= interventionLoadedAt ||
      loadedAt < restoredAt
    ) {
      return { status: 'blocked', reason: 'invalid_receipt_time' };
    }
    const releaseBlock = this.releaseVerified(input.mainCommitSha, input.loadedRuntimeRef);
    if (releaseBlock) return { status: 'blocked', reason: releaseBlock };
    const receiptRef = ownerRef('rollback', input);
    return this.appendReceipt(
      {
        schemaVersion: 1,
        eventId: `rollback:${input.proposalId}`,
        occurredAt: this.now(),
        ...input,
        type: 'rollback_recorded',
        receiptRef,
      },
      receiptRef,
    );
  }

  async resolveIntervention(receiptRef: OwnerTruthRefV1): Promise<EvalRepairInterventionReceipt | null> {
    const event = (await this.options.ledger.read()).find(
      (candidate) =>
        (candidate.type === 'intervention_changed' || candidate.type === 'intervention_no_change') &&
        sameRef(candidate.receiptRef, receiptRef),
    );
    if (!event || (event.type !== 'intervention_changed' && event.type !== 'intervention_no_change')) return null;
    const binding = await this.binding(event.proposalId);
    if ('status' in binding) return null;
    return event.type === 'intervention_changed'
      ? { kind: 'changed', ...binding.refs, ...event }
      : { kind: 'no_change', ...binding.refs, ...event };
  }

  async resolveFreshOutcome(receiptRef: OwnerTruthRefV1): Promise<EvalRepairFreshOutcomeReceipt | null> {
    const event = (await this.options.ledger.read()).find(
      (candidate) => candidate.type === 'fresh_outcome_recorded' && sameRef(candidate.receiptRef, receiptRef),
    );
    if (!event || event.type !== 'fresh_outcome_recorded') return null;
    const binding = await this.binding(event.proposalId);
    if ('status' in binding) return null;
    return { ...binding.refs, ...event };
  }
}
