import {
  type AsrPersonMemoryDynamicSceneEntryV1,
  asrPersonMemoryDynamicSceneEntryV1Schema,
  projectDeliveredWriteOpportunityRecord,
} from '@cat-cafe/shared';
import { supportsPreProviderContinuityHandshake } from '../../cats/services/agents/invocation/context-continuity.js';
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
  readonly projectionMarker: string;
  readonly state: WriteOpportunityLifecycleState;
}

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
  const coordinate = opportunity.sourceCoordinates[0];
  return [
    `<person-memory-write-opportunity v="1" id="${opportunity.opportunityId}">`,
    `mechanical_observation: ${opportunity.sourceCoordinates.length} owner-confirmed speaker mapping(s) are present`,
    `source: owner_message=${escapeXml(source.sourceMessageId)} artifact=${escapeXml(coordinate.artifactId)} revision=${coordinate.sourceRevision} bytes=${coordinate.segment.start}-${coordinate.segment.end}`,
    'ceiling: mechanical_observation; this does not establish intent, importance, or transcript truth.',
    // The full identity triple must be printed. dedupeLineage is NOT recoverable from opportunityId
    // -- writeOpportunityGenerationId keeps only the first 24 of its 32 hex chars -- so without this
    // line no cat can construct a valid writeOpportunityRef and every disposition silently falls
    // back to the unattributed path. IDs only, so this stays content-free.
    `writeOpportunityRef: opportunityId=${opportunity.opportunityId} dedupeLineage=${opportunity.dedupeLineage} generation=${opportunity.generation}`,
    'required judgment: load proactive-memory-judgment, then resolve exactly one disposition: propose | defer | abstain via the existing F276 tools.',
    'pass the writeOpportunityRef triple above verbatim to propose, defer, or abstain so the disposition is attributable; the server re-derives and rejects anything that does not match its own delivery evidence.',
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
      const projectionMarker = `person-memory-write-opportunity v="1" id="${opportunityId}"`;
      const receipt = { opportunityId, projectionMarker, state };
      admittedOpportunityIds.push(opportunityId);
      presentationReceipts.push(receipt);
      if (!presentationSupported) {
        omittedOpportunityIds.push(opportunityId);
        continue;
      }
      segments.push(renderOpportunity(state.scene, candidate.source));
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
