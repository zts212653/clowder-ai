import {
  type AsrPersonMemoryDynamicSceneEntryV1,
  type AsrPersonMemoryWriteOpportunityV1,
  asrPersonMemoryDynamicSceneEntryV1Schema,
  asrPersonMemoryWriteOpportunityV1Schema,
  type DeferredWriteOpportunityReceiptV1,
  type DeliveredWriteOpportunityRecordV1,
  deferredWriteOpportunityReceiptV1Schema,
  MAX_WRITE_OPPORTUNITY_GENERATION,
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
import {
  type DeliveredDispositionResult,
  type DeliveredOpportunityFacts,
  deliveredFactsFromRecord,
  deliveredFactsFromState,
  receiptMatchesOpportunity,
} from './write-opportunity-lineage.js';

export {
  MemoryContractTrialTelemetrySink,
  type MemoryContractTrialTraceEvent,
  type MemoryContractTrialTraceOutcome,
  type MemoryContractTrialTraceSink,
  type MemoryContractTrialTraceStage,
  memoryContractTrialTraceAttributes,
} from './AsrPersonMemoryContractTrialTelemetry.js';
export type { DeliveredDispositionResult } from './write-opportunity-lineage.js';

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
    const outcome = this.disposeDelivered(
      deliveredFactsFromState(state.scene.opportunity, state.presentation.occurredAt),
      candidate,
    );
    if (outcome.status === 'rejected') return { status: 'rejected', reason: outcome.reason };
    const next: WriteOpportunityLifecycleState = {
      ...state,
      status: 'disposed',
      disposition: outcome.disposition,
    };
    return outcome.receipt
      ? { status: 'transitioned', state: next, receipt: outcome.receipt }
      : { status: 'transitioned', state: next };
  }

  /**
   * Same disposition contract, reached from persisted delivery evidence instead of the in-invocation
   * lifecycle state. The cat's F276 tool call lands on a separate HTTP callback that has no access to
   * the invocation closure, so the facts have to come from the delivered record.
   *
   * This shares `disposeDelivered` with the state-based path on purpose: re-implementing the lineage
   * and expiry predicates inside a route is how the two paths would silently drift apart.
   */
  recordDeliveredDisposition(
    record: DeliveredWriteOpportunityRecordV1,
    candidate: unknown,
  ): DeliveredDispositionResult {
    return this.disposeDelivered(deliveredFactsFromRecord(record), candidate);
  }

  private disposeDelivered(facts: DeliveredOpportunityFacts, candidate: unknown): DeliveredDispositionResult {
    const parsed = writeOpportunityDispositionV1Schema.safeParse(candidate);
    if (!parsed.success) return this.rejectDisposition('invalid_disposition');
    const disposition = parsed.data;
    if (
      disposition.opportunityId !== facts.opportunityId ||
      disposition.generation !== facts.generation ||
      disposition.recordedAt < facts.presentedAt ||
      disposition.recordedAt >= facts.expiresAt
    ) {
      return this.rejectDisposition('disposition_lineage_mismatch');
    }
    if (disposition.disposition === 'defer' && disposition.recordedAt + 1 >= facts.expiresAt) {
      return this.rejectDisposition('expired');
    }
    this.trace.record({ stage: 'disposition', outcome: 'recorded', disposition: disposition.disposition });
    if (disposition.disposition === 'propose') {
      this.trace.record({ stage: 'burden', outcome: 'owner_approval_requested', units: 1 });
      return { status: 'recorded', disposition };
    }
    if (disposition.disposition !== 'defer') return { status: 'recorded', disposition };
    const receipt = deferredWriteOpportunityReceiptV1Schema.parse({
      v: 1,
      receiptId: disposition.destination.receiptId,
      opportunityId: facts.opportunityId,
      reflexId: facts.reflexId,
      reflexVersion: facts.reflexVersion,
      generation: facts.generation,
      dedupeLineage: facts.dedupeLineage,
      sourceRefs: facts.sourceRefs,
      eligibleAt: disposition.recordedAt + 1,
      expiresAt: facts.expiresAt,
      rearmPredicate: facts.rearmPredicate,
      destinationProposalContract: facts.destinationProposalContract,
      state: 'deferred',
    });
    return { status: 'recorded', disposition, receipt };
  }

  private rejectDisposition(reason: MemoryContractTrialTraceOutcome): DeliveredDispositionResult {
    this.trace.record({ stage: 'error', outcome: reason });
    return { status: 'rejected', reason };
  }

  reenterDeferred(
    receiptCandidate: unknown,
    originalCandidate: unknown,
    context: {
      now: number;
      reason: string;
      aclAllowed: boolean;
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
    if (!context.aclAllowed) return this.reentryFailure('suppressed', 'scope_revoked');
    if (opportunity.generation >= MAX_WRITE_OPPORTUNITY_GENERATION) {
      return this.reentryFailure('suppressed', 'generation_exhausted');
    }
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
