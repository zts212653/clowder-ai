import {
  type AsrPersonMemoryDynamicSceneEntryV1,
  type AsrPersonMemoryWriteOpportunityV1,
  asrPersonMemoryDynamicSceneEntryV1Schema,
  asrPersonMemoryWriteOpportunityV1Schema,
  type DeferredWriteOpportunityReceiptV1,
  deferredWriteOpportunityReceiptV1Schema,
  type WriteOpportunityDispositionV1,
  writeOpportunityDispositionV1Schema,
  writeOpportunityGenerationId,
} from '@cat-cafe/shared';
import {
  MemoryContractTrialTelemetrySink,
  type MemoryContractTrialTraceEvent,
  type MemoryContractTrialTraceOutcome,
  type MemoryContractTrialTraceSink,
} from './AsrPersonMemoryContractTrialTelemetry.js';

export {
  MemoryContractTrialTelemetrySink,
  type MemoryContractTrialTraceEvent,
  type MemoryContractTrialTraceOutcome,
  type MemoryContractTrialTraceSink,
  type MemoryContractTrialTraceStage,
  memoryContractTrialTraceAttributes,
} from './AsrPersonMemoryContractTrialTelemetry.js';

export class MemoryContractTrialTraceBuffer implements MemoryContractTrialTraceSink {
  readonly events: MemoryContractTrialTraceEvent[] = [];

  record(event: MemoryContractTrialTraceEvent): void {
    this.events.push(Object.freeze({ ...event }));
  }
}

export interface VerifiedOpportunityPresentation {
  readonly outcome: 'delivered' | 'omitted';
  readonly continuityDispositionRef: string;
  readonly generationId: string;
  readonly evidenceRef: string;
  readonly occurredAt: number;
}

export type PresentationVerification =
  | { readonly status: 'verified'; readonly value: VerifiedOpportunityPresentation }
  | { readonly status: 'invalid' };

export type OpportunityPresentationVerifier = (candidate: unknown) => PresentationVerification;

export interface WriteOpportunityLifecycleState {
  readonly status: 'eligible' | 'delivered' | 'omitted' | 'disposed' | 'invalidated' | 'expired';
  readonly scene: AsrPersonMemoryDynamicSceneEntryV1;
  readonly presentation?: VerifiedOpportunityPresentation;
  readonly disposition?: WriteOpportunityDispositionV1;
}

type TransitionResult =
  | {
      readonly status: 'transitioned';
      readonly state: WriteOpportunityLifecycleState;
      readonly receipt?: DeferredWriteOpportunityReceiptV1;
    }
  | { readonly status: 'rejected'; readonly reason: string };

export type AdmissionResult =
  | WriteOpportunityLifecycleState
  | { readonly status: 'rejected'; readonly reason: 'invalid_scene' };

function generationKey(opportunity: AsrPersonMemoryWriteOpportunityV1): string {
  return `${opportunity.dedupeLineage}:${opportunity.generation}`;
}

function receiptMatchesOpportunity(
  receipt: DeferredWriteOpportunityReceiptV1,
  opportunity: AsrPersonMemoryWriteOpportunityV1,
): boolean {
  if (
    receipt.opportunityId !== opportunity.opportunityId ||
    receipt.reflexId !== opportunity.reflexId ||
    receipt.reflexVersion !== opportunity.reflexVersion ||
    receipt.generation !== opportunity.generation ||
    receipt.dedupeLineage !== opportunity.dedupeLineage ||
    receipt.expiresAt !== opportunity.expiresAt ||
    receipt.rearmPredicate !== opportunity.rearmPredicate ||
    receipt.destinationProposalContract !== opportunity.destination.proposalContract ||
    receipt.sourceRefs.length !== opportunity.sourceCoordinates.length
  ) {
    return false;
  }
  return receipt.sourceRefs.every((ref, index) => {
    const coordinate = opportunity.sourceCoordinates[index];
    return (
      coordinate !== undefined &&
      ref.artifactId === coordinate.artifactId &&
      ref.sourceRevision === coordinate.sourceRevision &&
      ref.attributionRevision === coordinate.speaker.attributionRevision &&
      ref.segmentStart === coordinate.segment.start &&
      ref.segmentEnd === coordinate.segment.end
    );
  });
}

function admissionFailureReason(
  opportunity: AsrPersonMemoryWriteOpportunityV1,
  context: {
    now: number;
    ownerUserId: string;
    threadId: string;
    consumerCatId: string;
    predicateRevision: number;
    aclAllowed: boolean;
    terminalGenerationKeys: ReadonlySet<string>;
  },
): MemoryContractTrialTraceOutcome | null {
  if (opportunity.scope.ownerUserId !== context.ownerUserId || opportunity.scope.threadId !== context.threadId) {
    return 'scope_mismatch';
  }
  if (opportunity.consumer.catId !== context.consumerCatId) return 'scope_mismatch';
  if (context.predicateRevision !== opportunity.reflexVersion) return 'predicate_revision_mismatch';
  if (!context.aclAllowed) return 'scope_revoked';
  if (context.now >= opportunity.expiresAt) return 'expired';
  if (context.now < opportunity.eligibleAt) return 'not_yet_eligible';
  if (context.terminalGenerationKeys.has(generationKey(opportunity))) return 'duplicate_generation';
  return null;
}

export class AsrPersonMemoryContractTrial {
  private readonly trace: MemoryContractTrialTraceSink;

  constructor(
    private readonly options: {
      readonly presentationVerifier?: OpportunityPresentationVerifier | null;
      readonly trace?: MemoryContractTrialTraceSink;
    } = {},
  ) {
    this.trace = options.trace ?? new MemoryContractTrialTelemetrySink();
  }

  admit(
    candidate: unknown,
    context: {
      now: number;
      ownerUserId: string;
      threadId: string;
      consumerCatId: string;
      predicateRevision: number;
      aclAllowed: boolean;
      terminalGenerationKeys: ReadonlySet<string>;
    },
  ): AdmissionResult {
    const parsed = asrPersonMemoryDynamicSceneEntryV1Schema.safeParse(candidate);
    if (!parsed.success) {
      this.trace.record({ stage: 'error', outcome: 'invalid_scene' });
      return { status: 'rejected', reason: 'invalid_scene' };
    }
    const scene = parsed.data;
    const opportunity = scene.opportunity;
    const reason = admissionFailureReason(opportunity, context);
    if (reason) {
      this.trace.record({ stage: reason === 'expired' ? 'omitted' : 'error', outcome: reason });
      return { status: reason === 'expired' ? 'expired' : 'invalidated', scene };
    }
    this.trace.record({ stage: 'eligible', outcome: 'admitted' });
    return { status: 'eligible', scene };
  }

  recordPresentation(state: WriteOpportunityLifecycleState, candidate: unknown): TransitionResult {
    if (state.status !== 'eligible') return this.reject('opportunity_not_eligible');
    const verified = this.options.presentationVerifier?.(candidate);
    if (!verified || verified.status !== 'verified') return this.reject('continuity_authority_unavailable');
    const evidence = verified.value;
    if (
      !evidence.continuityDispositionRef ||
      !/^sha256:[a-f0-9]{64}$/.test(evidence.generationId) ||
      !evidence.evidenceRef ||
      evidence.occurredAt < state.scene.opportunity.eligibleAt ||
      evidence.occurredAt >= state.scene.opportunity.expiresAt
    ) {
      return this.reject('invalid_presentation_evidence');
    }
    const status = evidence.outcome;
    this.trace.record({ stage: status, outcome: status });
    return { status: 'transitioned', state: { ...state, status, presentation: evidence } };
  }

  recordDisposition(state: WriteOpportunityLifecycleState, candidate: unknown): TransitionResult {
    if (state.status === 'disposed') return this.reject('already_disposed');
    if (state.status !== 'delivered' || !state.presentation) return this.reject('delivery_required');
    const parsed = writeOpportunityDispositionV1Schema.safeParse(candidate);
    if (!parsed.success) return this.reject('invalid_disposition');
    const disposition = parsed.data;
    const opportunity = state.scene.opportunity;
    if (
      disposition.opportunityId !== opportunity.opportunityId ||
      disposition.generation !== opportunity.generation ||
      disposition.recordedAt < state.presentation.occurredAt ||
      disposition.recordedAt >= opportunity.expiresAt
    ) {
      return this.reject('disposition_lineage_mismatch');
    }
    this.trace.record({ stage: 'disposition', outcome: 'recorded', disposition: disposition.disposition });
    const next: WriteOpportunityLifecycleState = { ...state, status: 'disposed', disposition };
    if (disposition.disposition === 'propose') {
      this.trace.record({ stage: 'burden', outcome: 'owner_approval_requested', units: 1 });
      return { status: 'transitioned', state: next };
    }
    if (disposition.disposition !== 'defer') return { status: 'transitioned', state: next };
    const receipt = deferredWriteOpportunityReceiptV1Schema.parse({
      v: 1,
      receiptId: disposition.destination.receiptId,
      opportunityId: opportunity.opportunityId,
      reflexId: opportunity.reflexId,
      reflexVersion: opportunity.reflexVersion,
      generation: opportunity.generation,
      dedupeLineage: opportunity.dedupeLineage,
      sourceRefs: opportunity.sourceCoordinates.map((coordinate) => ({
        artifactId: coordinate.artifactId,
        sourceRevision: coordinate.sourceRevision,
        attributionRevision: coordinate.speaker.attributionRevision,
        segmentStart: coordinate.segment.start,
        segmentEnd: coordinate.segment.end,
      })),
      eligibleAt: disposition.recordedAt + 1,
      expiresAt: opportunity.expiresAt,
      rearmPredicate: opportunity.rearmPredicate,
      destinationProposalContract: opportunity.destination.proposalContract,
      state: 'deferred',
    });
    return { status: 'transitioned', state: next, receipt };
  }

  reenterDeferred(
    receiptCandidate: unknown,
    originalCandidate: unknown,
    context: {
      now: number;
      reason: string;
      aclAllowed: boolean;
      sourceRevision: string;
      attributionRevision: string;
      terminalGenerationKeys: ReadonlySet<string>;
    },
  ):
    | { status: 'reentered'; scene: AsrPersonMemoryDynamicSceneEntryV1; receipt: DeferredWriteOpportunityReceiptV1 }
    | { status: 'rejected' | 'suppressed'; reason: string } {
    const receipt = deferredWriteOpportunityReceiptV1Schema.safeParse(receiptCandidate);
    const opportunityCandidate = asrPersonMemoryWriteOpportunityV1Schema.safeParse(originalCandidate);
    if (!receipt.success || !opportunityCandidate.success) {
      return this.reentryFailure('rejected', 'invalid_lineage');
    }
    const original: AsrPersonMemoryDynamicSceneEntryV1 = {
      v: 1,
      kind: 'memory_write_opportunity',
      surface: 'dynamic_context',
      opportunity: opportunityCandidate.data,
    };
    const opportunity = original.opportunity;
    if (receipt.data.state !== 'deferred') {
      return this.reentryFailure('rejected', 'receipt_not_deferred');
    }
    if (!receiptMatchesOpportunity(receipt.data, opportunity)) {
      return this.reentryFailure('rejected', 'invalid_lineage');
    }
    if (
      receipt.data.sourceRefs.some(
        (ref) =>
          ref.sourceRevision !== context.sourceRevision || ref.attributionRevision !== context.attributionRevision,
      )
    ) {
      return this.reentryFailure('rejected', 'source_revision_mismatch');
    }
    if (!context.aclAllowed) return this.reentryFailure('suppressed', 'scope_revoked');
    if (context.now >= receipt.data.expiresAt) return this.reentryFailure('suppressed', 'expired');
    if (context.now < receipt.data.eligibleAt) return this.reentryFailure('rejected', 'not_yet_eligible');
    if (context.reason !== 'eligible_owner_context') {
      return this.reentryFailure('rejected', 'rearm_predicate_not_met');
    }

    const generation = opportunity.generation + 1;
    const nextOpportunity = {
      ...opportunity,
      opportunityId: writeOpportunityGenerationId(opportunity.dedupeLineage, generation),
      generation,
      eligibleAt: context.now,
    };
    if (context.terminalGenerationKeys.has(generationKey(nextOpportunity))) {
      return this.reentryFailure('rejected', 'duplicate_generation');
    }
    const scene = asrPersonMemoryDynamicSceneEntryV1Schema.parse({
      ...original,
      opportunity: nextOpportunity,
    });
    this.trace.record({ stage: 'eligible', outcome: 'rearmed_after_defer' });
    return { status: 'reentered', scene, receipt: { ...receipt.data, state: 'reentered' } };
  }

  async readDestinationOutcome(
    state: WriteOpportunityLifecycleState,
    reader: { getStatus(proposalId: string): Promise<{ status: string; proposalId: string } | null> },
  ): Promise<{ status: 'approved' | 'rejected' | 'not_now' | 'pending' | 'not_available'; proposalId?: string }> {
    if (state.status !== 'disposed' || state.disposition?.disposition !== 'propose') {
      return { status: 'not_available' };
    }
    const proposalId = state.disposition.destination.proposalId;
    const current = await reader.getStatus(proposalId);
    if (!current || current.proposalId !== proposalId) return { status: 'not_available' };
    if (current.status === 'materialized') return { status: 'approved', proposalId };
    if (current.status === 'rejected') return { status: 'rejected', proposalId };
    if (current.status === 'not_now') return { status: 'not_now', proposalId };
    return { status: 'pending', proposalId };
  }

  private reject(reason: MemoryContractTrialTraceOutcome): TransitionResult {
    this.trace.record({ stage: 'error', outcome: reason });
    return { status: 'rejected', reason };
  }

  private reentryFailure(
    status: 'rejected' | 'suppressed',
    reason: MemoryContractTrialTraceOutcome,
  ): { status: 'rejected' | 'suppressed'; reason: string } {
    this.trace.record({ stage: reason === 'expired' ? 'omitted' : 'error', outcome: reason });
    return { status, reason };
  }
}
