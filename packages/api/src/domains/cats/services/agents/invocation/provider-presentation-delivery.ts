import { createHash } from 'node:crypto';
import { estimateTokens } from '../../../../../utils/token-counter.js';
import {
  type AdmittedOpportunityPresentationV1,
  type ContextPresentation,
  type ContextPresentationEnvelope,
  mapToPresentation,
} from '../../session/context-presentation.js';
import type { DeliveryReceipt } from '../../session/delivery-receipt.js';
import type {
  CommitOutcome,
  PresentationLedger,
  PresentationReservation,
  PresentationScope,
} from '../../session/PresentationLedger.js';

export type ProviderPromptPresentationEnvelope<TReceipt> = ContextPresentationEnvelope<TReceipt>;

interface ReservedProviderPromptPresentation<TReceipt> {
  readonly envelope: ProviderPromptPresentationEnvelope<TReceipt>;
  readonly presentation: ContextPresentation;
  readonly promptSegment: string;
  readonly reservation: PresentationReservation;
}

export interface AdmittedProviderPromptPresentation<TReceipt> {
  readonly envelope: ProviderPromptPresentationEnvelope<TReceipt>;
  readonly presentation: ContextPresentation;
  readonly promptSegment: string;
}

export interface ProviderPresentationCommit<TReceipt> {
  readonly envelope: ProviderPromptPresentationEnvelope<TReceipt>;
  readonly presentation: ContextPresentation;
  readonly outcome: CommitOutcome;
}

export interface ProviderPresentationAttempt<TReceipt> {
  readonly effectivePrompt: string;
  readonly promptGenerationId: string;
  readonly admitted: readonly AdmittedProviderPromptPresentation<TReceipt>[];
  readonly omitted: readonly ProviderPromptPresentationEnvelope<TReceipt>[];
  confirm(receipt: DeliveryReceipt): Promise<readonly ProviderPresentationCommit<TReceipt>[]>;
  release(reason: string): Promise<void>;
}

export function promptGenerationId(effectivePrompt: string): string {
  return `sha256:${createHash('sha256').update(effectivePrompt).digest('hex')}`;
}

export interface OpportunityPresentationContext {
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly invocationId: string;
  readonly consumerCatId: string;
  readonly surface: 'dynamic_context';
  readonly now: number;
}

function sameRevision(
  left: AdmittedOpportunityPresentationV1['asOf'],
  right: AdmittedOpportunityPresentationV1['asOf'],
): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function matchesConsumerScope(
  admission: AdmittedOpportunityPresentationV1,
  context: OpportunityPresentationContext,
): boolean {
  const scope = admission.consumerScope;
  if (scope.ownerUserId !== context.ownerUserId || scope.threadId !== context.threadId) return false;
  return scope.kind === 'invocation'
    ? scope.invocationId === context.invocationId
    : scope.consumerCatId === context.consumerCatId;
}

/** Revalidate the producer-owned admission facts at the last pre-provider boundary. */
function isCurrentAdmission<TReceipt>(
  envelope: ProviderPromptPresentationEnvelope<TReceipt>,
  context: OpportunityPresentationContext | undefined,
): boolean {
  const admission = envelope.admission;
  if (!admission || !context) return false;
  if (
    !admission.opportunityId ||
    !admission.producerOwner ||
    !admission.entryVersion ||
    !admission.presentationPolicyRef ||
    !admission.dedupeKey ||
    admission.sourceRefs.length === 0 ||
    admission.invalidators.length === 0 ||
    !Number.isInteger(admission.tokenBudget) ||
    admission.tokenBudget <= 0 ||
    !Number.isInteger(admission.expiresAt) ||
    context.now >= admission.expiresAt ||
    !admission.eligibleSurfaces.includes(context.surface) ||
    !matchesConsumerScope(admission, context) ||
    admission.subjectKey !== envelope.candidate.subjectKey ||
    !sameRevision(admission.asOf, envelope.candidate.asOf) ||
    admission.epistemicCeiling !== envelope.candidate.epistemicCeiling
  ) {
    return false;
  }
  return true;
}

async function releaseReservations<TReceipt>(
  ledger: Pick<PresentationLedger, 'release'>,
  reserved: readonly ReservedProviderPromptPresentation<TReceipt>[],
  reason: string,
): Promise<void> {
  await Promise.all(reserved.map(({ reservation }) => ledger.release(reservation, reason)));
}

/**
 * Reserve the exact set of dynamic projections that will enter one provider prompt.
 *
 * Admission changes prompt bytes, while the reservation must be bound to the SHA-256
 * of those final bytes. The loop resolves that dependency without a speculative or
 * second generation id: a rejected projection monotonically shrinks the candidate
 * set, acquired reservations are released, and the prompt is re-hashed. The set can
 * shrink at most `N` times, so the loop is bounded by construction.
 */
export async function prepareProviderPresentationAttempt<TReceipt>(input: {
  readonly envelopes: readonly ProviderPromptPresentationEnvelope<TReceipt>[];
  readonly ledger?: Pick<PresentationLedger, 'reserve' | 'commit' | 'release'>;
  readonly scope?: PresentationScope;
  readonly opportunityContext?: OpportunityPresentationContext;
  readonly buildEffectivePrompt: (promptSegments: readonly string[]) => string;
  /** F299: production callers bind this to the transcript owner's persistent HMAC key. */
  readonly createPromptGenerationId?: (effectivePrompt: string) => string | Promise<string>;
}): Promise<ProviderPresentationAttempt<TReceipt>> {
  const createGenerationId = input.createPromptGenerationId ?? promptGenerationId;
  const currentEnvelopes = input.envelopes.filter((envelope) => isCurrentAdmission(envelope, input.opportunityContext));
  const invalidEnvelopes = input.envelopes.filter(
    (envelope) => !isCurrentAdmission(envelope, input.opportunityContext),
  );
  const projected = currentEnvelopes.map((envelope) => ({
    envelope,
    presentation: mapToPresentation(envelope.candidate),
  }));
  const selectable = projected.flatMap((item) => {
    if (item.presentation.presentation === 'omit') return [];
    const promptSegment = item.envelope.segments[item.presentation.presentation];
    return promptSegment && estimateTokens(promptSegment) <= item.envelope.admission.tokenBudget
      ? [{ ...item, promptSegment }]
      : [];
  });
  const mapperOmitted = projected.filter((item) => {
    if (item.presentation.presentation === 'omit') return true;
    const promptSegment = item.envelope.segments[item.presentation.presentation];
    return !promptSegment || estimateTokens(promptSegment) > item.envelope.admission.tokenBudget;
  });

  // No authoritative epoch means unsupported continuity. Fail closed by withholding
  // dynamic content; do not invent a process-local scope or bypass the mapper.
  if (!input.scope) {
    const effectivePrompt = input.buildEffectivePrompt([]);
    return createAttempt({
      effectivePrompt,
      promptGenerationId: await createGenerationId(effectivePrompt),
      ledger: input.ledger,
      reserved: [],
      omitted: [...invalidEnvelopes, ...projected.map(({ envelope }) => envelope)],
    });
  }

  let remaining = selectable;
  const omitted = [...invalidEnvelopes, ...mapperOmitted.map(({ envelope }) => envelope)];
  if (remaining.length > 0 && !input.ledger) throw new Error('presentation_ledger_unavailable');

  for (;;) {
    const effectivePrompt = input.buildEffectivePrompt(remaining.map(({ promptSegment }) => promptSegment));
    const generationId = await createGenerationId(effectivePrompt);
    if (remaining.length === 0) {
      return createAttempt({
        effectivePrompt,
        promptGenerationId: generationId,
        ledger: input.ledger,
        reserved: [],
        omitted,
      });
    }

    const ledger = input.ledger as Pick<PresentationLedger, 'reserve' | 'commit' | 'release'>;
    const reserved: ReservedProviderPromptPresentation<TReceipt>[] = [];
    const rejected: typeof remaining = [];
    try {
      for (const item of remaining) {
        const outcome = await ledger.reserve(item.presentation, input.scope, {
          promptGenerationId: generationId,
        });
        if (outcome.admitted) {
          reserved.push({ ...item, reservation: outcome.reservation });
        } else {
          rejected.push(item);
        }
      }
    } catch (error) {
      await releaseReservations(ledger, reserved, 'reservation_batch_failed');
      throw error;
    }

    if (rejected.length === 0) {
      return createAttempt({
        effectivePrompt,
        promptGenerationId: generationId,
        ledger,
        reserved,
        omitted,
      });
    }

    await releaseReservations(ledger, reserved, 'prompt_generation_rebuild');
    omitted.push(...rejected.map(({ envelope }) => envelope));
    remaining = reserved.map(({ envelope, presentation, promptSegment }) => ({
      envelope,
      presentation,
      promptSegment,
    }));
  }
}

function createAttempt<TReceipt>(input: {
  readonly effectivePrompt: string;
  readonly promptGenerationId: string;
  readonly ledger?: Pick<PresentationLedger, 'commit' | 'release'>;
  readonly reserved: readonly ReservedProviderPromptPresentation<TReceipt>[];
  readonly omitted: readonly ProviderPromptPresentationEnvelope<TReceipt>[];
}): ProviderPresentationAttempt<TReceipt> {
  let terminal: 'open' | 'confirmed' | 'released' = 'open';
  return {
    effectivePrompt: input.effectivePrompt,
    promptGenerationId: input.promptGenerationId,
    admitted: input.reserved.map(({ envelope, presentation, promptSegment }) => ({
      envelope,
      presentation,
      promptSegment,
    })),
    omitted: [...input.omitted],
    async confirm(receipt) {
      if (terminal !== 'open') return [];
      terminal = 'confirmed';
      const ledger = input.ledger;
      if (!ledger) return [];
      return Promise.all(
        input.reserved.map(async ({ envelope, presentation, reservation }) => ({
          envelope,
          presentation,
          outcome: await ledger.commit(reservation, receipt),
        })),
      );
    },
    async release(reason) {
      if (terminal !== 'open') return;
      terminal = 'released';
      if (!input.ledger) return;
      await releaseReservations(input.ledger, input.reserved, reason);
    },
  };
}
