import {
  ASR_PERSON_MEMORY_REFLEX_ENTRY_V1,
  type AsrPersonMemoryDynamicSceneEntryV1,
  asrPersonMemoryDynamicSceneEntryV1Schema,
  projectDeliveredWriteOpportunityRecord,
} from '@cat-cafe/shared';
import { supportsPreProviderContinuityHandshake } from '../../cats/services/agents/invocation/context-continuity.js';
import type { ContextPresentationEnvelope } from '../../cats/services/session/context-presentation.js';
import type { ContextContinuityHandshake } from '../../cats/services/types.js';
import {
  AsrPersonMemoryContractTrial,
  MemoryContractTrialTelemetrySink,
  type MemoryContractTrialTraceSink,
  type OpportunityPresentationVerifier,
  type WriteOpportunityLifecycleState,
} from './AsrPersonMemoryContractTrial.js';
import type { WriteOpportunityDeliveryStore } from './WriteOpportunityDeliveryStore.js';
import { terminalGenerationKeysFrom, type WriteOpportunityTerminalLedger } from './WriteOpportunityTerminalLedger.js';

export interface BoundAsrPersonMemoryScene {
  readonly scene: unknown;
  readonly source: {
    readonly kind: 'message';
    readonly threadId: string;
    readonly sourceMessageId: string;
    readonly authorUserId: string;
    readonly authorRole: 'owner';
    /** Minted only after Queue re-reads a live, non-tombstoned message in the exact owner/thread scope. */
    readonly visibility: 'verified_live_owner_message';
  };
}

export interface AsrPersonMemoryPresentationReceipt {
  readonly opportunityId: string;
  readonly state: WriteOpportunityLifecycleState;
}

export type AsrPersonMemoryPresentationEnvelope = ContextPresentationEnvelope<AsrPersonMemoryPresentationReceipt>;

export interface AsrPersonMemoryPresentationConfirmation {
  readonly outcome: 'delivered' | 'omitted';
  readonly continuity: ContextContinuityHandshake;
  readonly generationId: string;
  readonly evidenceRef: string;
  readonly occurredAt: number;
}

export interface AsrPersonMemoryPromptResolution {
  readonly promptSegment: string;
  readonly admittedOpportunityIds: readonly string[];
  readonly omittedOpportunityIds: readonly string[];
  readonly presentationReceipts: readonly AsrPersonMemoryPresentationReceipt[];
  readonly deliveryReceipts: readonly AsrPersonMemoryPresentationReceipt[];
  readonly presentationEnvelopes: readonly AsrPersonMemoryPresentationEnvelope[];
}

function f296PresentationVerifier(candidate: unknown) {
  if (!candidate || typeof candidate !== 'object') return { status: 'invalid' } as const;
  const value = candidate as Record<string, unknown>;
  const continuity = value.continuity as ContextContinuityHandshake | undefined;
  if (
    value.kind !== 'f296_write_opportunity_presentation_v1' ||
    (value.outcome !== 'delivered' && value.outcome !== 'omitted') ||
    !continuity ||
    typeof continuity.disposition?.evidenceRef !== 'string' ||
    value.continuityDispositionRef !== continuity.disposition.evidenceRef ||
    typeof value.generationId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.generationId) ||
    typeof value.evidenceRef !== 'string' ||
    !value.evidenceRef.startsWith('context-delivery:') ||
    typeof value.occurredAt !== 'number' ||
    !Number.isInteger(value.occurredAt) ||
    value.occurredAt < 0
  ) {
    return { status: 'invalid' } as const;
  }
  if (value.outcome === 'delivered' && !supportsPreProviderContinuityHandshake(continuity)) {
    return { status: 'invalid' } as const;
  }
  return {
    status: 'verified',
    value: {
      outcome: value.outcome,
      continuityDispositionRef: value.continuityDispositionRef,
      generationId: value.generationId,
      evidenceRef: value.evidenceRef,
      occurredAt: value.occurredAt,
    },
  } as const;
}

export const verifyAsrPersonMemoryF296Presentation: OpportunityPresentationVerifier = f296PresentationVerifier;

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function renderOpportunity(
  scene: AsrPersonMemoryDynamicSceneEntryV1,
  source: BoundAsrPersonMemoryScene['source'],
): string {
  const opportunity = scene.opportunity;
  return [
    '<person-memory-write-opportunity v="1">',
    `mechanical_observation:${opportunity.sourceCoordinates.length} mappings; not intent/importance/truth; source_message=${escapeXml(source.sourceMessageId)}`,
    // The full identity triple must be printed. dedupeLineage is NOT recoverable from opportunityId
    // -- writeOpportunityGenerationId keeps only the first 24 of its 32 hex chars -- so without this
    // line no cat can construct a valid writeOpportunityRef and every disposition silently falls
    // back to the unattributed path. IDs only, so this stays content-free.
    `writeOpportunityRef: opportunityId=${opportunity.opportunityId} dedupeLineage=${opportunity.dedupeLineage} generation=${opportunity.generation}`,
    'load proactive-memory-judgment; propose | defer | abstain; pass the writeOpportunityRef triple above verbatim to propose, defer, or abstain.',
    '</person-memory-write-opportunity>',
  ].join('\n');
}

export class AsrPersonMemoryOpportunityPromptService {
  private readonly trial: AsrPersonMemoryContractTrial;

  private readonly terminalLedger?: WriteOpportunityTerminalLedger;
  private readonly deliveryStore?: WriteOpportunityDeliveryStore;
  private readonly trace: MemoryContractTrialTraceSink;

  constructor(
    options: {
      readonly trace?: MemoryContractTrialTraceSink;
      readonly terminalLedger?: WriteOpportunityTerminalLedger;
      readonly deliveryStore?: WriteOpportunityDeliveryStore;
    } = {},
  ) {
    if (options.terminalLedger) this.terminalLedger = options.terminalLedger;
    if (options.deliveryStore) this.deliveryStore = options.deliveryStore;
    this.trace = options.trace ?? new MemoryContractTrialTelemetrySink();
    this.trial = new AsrPersonMemoryContractTrial({
      presentationVerifier: verifyAsrPersonMemoryF296Presentation,
      trace: this.trace,
    });
  }

  resolve(input: {
    readonly candidates: readonly BoundAsrPersonMemoryScene[];
    readonly serverScope: {
      readonly ownerUserId: string;
      readonly threadId: string;
      readonly consumerCatId: string;
    };
    readonly continuity: ContextContinuityHandshake;
    readonly now: number;
    readonly terminalGenerationKeys: ReadonlySet<string>;
  }): AsrPersonMemoryPromptResolution {
    const admittedOpportunityIds: string[] = [];
    const omittedOpportunityIds: string[] = [];
    const presentationReceipts: AsrPersonMemoryPresentationReceipt[] = [];
    const presentationEnvelopes: AsrPersonMemoryPresentationEnvelope[] = [];
    const segments: string[] = [];
    const presentationSupported = supportsPreProviderContinuityHandshake(input.continuity);
    const seenGenerationKeys = new Set(input.terminalGenerationKeys);

    for (const candidate of input.candidates) {
      if (
        candidate.source.kind !== 'message' ||
        candidate.source.authorRole !== 'owner' ||
        candidate.source.visibility !== 'verified_live_owner_message' ||
        candidate.source.authorUserId !== input.serverScope.ownerUserId ||
        candidate.source.threadId !== input.serverScope.threadId
      ) {
        continue;
      }
      const state = this.trial.admit(candidate.scene, {
        now: input.now,
        ...input.serverScope,
        predicateRevision: 1,
        // The typed visibility witness is emitted only by the Queue carrier after its live
        // owner/thread/deletion checks; candidates without that witness are rejected above.
        aclAllowed: true,
        terminalGenerationKeys: seenGenerationKeys,
      });
      if (state.status !== 'eligible') continue;
      const opportunityId = state.scene.opportunity.opportunityId;
      seenGenerationKeys.add(`${state.scene.opportunity.dedupeLineage}:${state.scene.opportunity.generation}`);
      const receipt = { opportunityId, state };
      admittedOpportunityIds.push(opportunityId);
      presentationReceipts.push(receipt);
      if (!presentationSupported) {
        omittedOpportunityIds.push(opportunityId);
        continue;
      }
      const promptSegment = renderOpportunity(state.scene, candidate.source);
      segments.push(promptSegment);
      const opportunity = state.scene.opportunity;
      const subjectKey = `write-opportunity:${opportunity.dedupeLineage}`;
      const asOf = { kind: 'version' as const, value: String(opportunity.generation) };
      presentationEnvelopes.push({
        candidate: {
          subjectKey,
          asOf,
          sourceTier: 'T0',
          requested: 'state',
          epistemicCeiling: 'mechanical_observation',
        },
        segments: { state: promptSegment },
        admission: {
          opportunityId: opportunity.opportunityId,
          opportunityKind: 'write',
          producerOwner: ASR_PERSON_MEMORY_REFLEX_ENTRY_V1.ownerCell,
          consumerScope: { kind: 'cat', ...opportunity.scope, consumerCatId: opportunity.consumer.catId },
          entryVersion: `${opportunity.reflexId}:${opportunity.reflexVersion}`,
          subjectKey,
          asOf,
          sourceRefs: opportunity.sourceCoordinates.map((coordinate) =>
            [
              coordinate.artifactId,
              coordinate.sourceHandle,
              coordinate.sourceRevision,
              `${coordinate.segment.start}-${coordinate.segment.end}`,
              coordinate.speaker.externalSpeakerId,
              coordinate.speaker.attributionRevision,
            ].join('@'),
          ),
          eligibleSurfaces: ASR_PERSON_MEMORY_REFLEX_ENTRY_V1.eligibleSurfaces,
          presentationPolicyRef: ASR_PERSON_MEMORY_REFLEX_ENTRY_V1.presentationPolicyRef,
          tokenBudget: ASR_PERSON_MEMORY_REFLEX_ENTRY_V1.tokenBudget,
          dedupeKey: `${opportunity.dedupeLineage}:${opportunity.generation}`,
          expiresAt: opportunity.expiresAt,
          invalidators: ASR_PERSON_MEMORY_REFLEX_ENTRY_V1.invalidators.map((ref) => ({
            owner: ASR_PERSON_MEMORY_REFLEX_ENTRY_V1.ownerCell,
            ref,
          })),
          epistemicCeiling: opportunity.epistemicCeiling,
        },
        receipt,
      });
    }

    const deliveryReceipts = presentationReceipts.filter(
      (receipt) => !omittedOpportunityIds.includes(receipt.opportunityId),
    );
    return {
      promptSegment: segments.join('\n\n'),
      admittedOpportunityIds,
      omittedOpportunityIds,
      presentationReceipts,
      deliveryReceipts,
      presentationEnvelopes,
    };
  }

  /**
   * Ledger-aware admission for a real invocation.
   *
   * Two things the pure `resolve` cannot do, because both need persisted cross-invocation truth:
   *  - suppress a lineage that correction / forget / scope-revoke already killed (SR:129 — an
   *    invalidated generation must never be re-sent, not even after a carrier resume)
   *  - suppress a generation that was already judged in an earlier invocation
   *
   * Read, never notified: this domain has no invalidation event bus, so the bridge revalidates at
   * admission. With no ledger configured it degrades to the pure in-invocation behavior rather than
   * silently pretending nothing is terminal.
   */
  async resolveForInvocation(input: {
    readonly candidates: readonly BoundAsrPersonMemoryScene[];
    readonly serverScope: {
      readonly ownerUserId: string;
      readonly threadId: string;
      readonly consumerCatId: string;
    };
    readonly continuity: ContextContinuityHandshake;
    readonly now: number;
  }): Promise<AsrPersonMemoryPromptResolution> {
    if (!this.terminalLedger || !this.deliveryStore) {
      // A prompt with no durable disposition authority is mechanically unanswerable: the cat could
      // see the ref but every callback would fail to bind. Preserve an explicit omitted receipt for
      // runtime evidence, while withholding the payload-bearing prompt segment.
      this.trace.record({ stage: 'error', outcome: 'disposition_authority_unavailable' });
      const omitted = this.resolve({ ...input, terminalGenerationKeys: new Set() });
      return {
        ...omitted,
        promptSegment: '',
        omittedOpportunityIds: omitted.admittedOpportunityIds,
        deliveryReceipts: [],
        presentationEnvelopes: [],
      };
    }
    // A configured ledger is invalidation authority, not optional bookkeeping. If its read fails,
    // omit these opportunities for this turn: degrading to an empty terminal set could re-present
    // a generation killed by correct / forget / ACL revoke and expose stale payload.
    const lineages = input.candidates
      .map((candidate) => asrPersonMemoryDynamicSceneEntryV1Schema.safeParse(candidate.scene))
      .flatMap((parsed) => (parsed.success ? [parsed.data.opportunity.dedupeLineage] : []));
    let states: Awaited<ReturnType<WriteOpportunityTerminalLedger['readLineageStates']>>;
    try {
      states = await this.terminalLedger.readLineageStates(input.serverScope.ownerUserId, lineages);
    } catch {
      this.trace.record({ stage: 'error', outcome: 'terminal_ledger_unavailable' });
      return this.resolve({ ...input, candidates: [], terminalGenerationKeys: new Set() });
    }

    const live = input.candidates.filter((candidate) => {
      const parsed = asrPersonMemoryDynamicSceneEntryV1Schema.safeParse(candidate.scene);
      if (!parsed.success) return true; // let admit() reject it with a typed invalid_scene
      const state = states.get(parsed.data.opportunity.dedupeLineage);
      return state?.invalidatedReason === undefined;
    });

    return this.resolve({
      ...input,
      candidates: live,
      terminalGenerationKeys: terminalGenerationKeysFrom(states),
    });
  }

  /**
   * Persist delivery evidence so the cat's later F276 tool callback can be bound back to the exact
   * opportunity. Only `delivered` receipts are persisted: an omission is not a delivery and must not
   * become dispositionable (F296:270-271).
   */
  async persistDeliveredRecords(
    receipts: readonly AsrPersonMemoryPresentationReceipt[],
    confirmation: AsrPersonMemoryPresentationConfirmation & { readonly invocationId: string },
  ): Promise<void> {
    if (!this.deliveryStore || confirmation.outcome !== 'delivered') return;
    for (const receipt of receipts) {
      const opportunity = receipt.state.scene.opportunity;
      await this.deliveryStore.recordDelivered(
        projectDeliveredWriteOpportunityRecord(opportunity, {
          ownerUserId: opportunity.scope.ownerUserId,
          threadId: opportunity.scope.threadId,
          consumerCatId: opportunity.consumer.catId,
          invocationId: confirmation.invocationId,
          presentedAt: confirmation.occurredAt,
          generationId: confirmation.generationId,
          evidenceRef: confirmation.evidenceRef,
          continuityDispositionRef: confirmation.continuity.disposition.evidenceRef,
        }),
      );
    }
  }

  recordPresentation(
    receipts: readonly AsrPersonMemoryPresentationReceipt[],
    confirmation: AsrPersonMemoryPresentationConfirmation,
  ): readonly AsrPersonMemoryPresentationReceipt[] {
    const accepted: AsrPersonMemoryPresentationReceipt[] = [];
    for (const receipt of receipts) {
      const transition = this.trial.recordPresentation(receipt.state, {
        kind: 'f296_write_opportunity_presentation_v1',
        ...confirmation,
        continuityDispositionRef: confirmation.continuity.disposition.evidenceRef,
      });
      if (transition.status === 'transitioned') accepted.push(receipt);
    }
    return accepted;
  }
}
