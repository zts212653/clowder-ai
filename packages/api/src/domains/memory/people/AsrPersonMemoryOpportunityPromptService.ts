import type { AsrPersonMemoryDynamicSceneEntryV1 } from '@cat-cafe/shared';
import { supportsPreProviderContinuityHandshake } from '../../cats/services/agents/invocation/context-continuity.js';
import type { ContextContinuityHandshake } from '../../cats/services/types.js';
import {
  AsrPersonMemoryContractTrial,
  type MemoryContractTrialTraceSink,
  type OpportunityPresentationVerifier,
  type WriteOpportunityLifecycleState,
} from './AsrPersonMemoryContractTrial.js';

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
    'required judgment: load proactive-memory-judgment, then resolve exactly one disposition: propose | defer | abstain via the existing F276 tools.',
    '</person-memory-write-opportunity>',
  ].join('\n');
}

export class AsrPersonMemoryOpportunityPromptService {
  private readonly trial: AsrPersonMemoryContractTrial;

  constructor(options: { readonly trace?: MemoryContractTrialTraceSink } = {}) {
    this.trial = new AsrPersonMemoryContractTrial({
      presentationVerifier: verifyAsrPersonMemoryF296Presentation,
      ...(options.trace ? { trace: options.trace } : {}),
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
