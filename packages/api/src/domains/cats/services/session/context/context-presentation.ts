/**
 * F296 B2b: the presentation contract.
 *
 * Every dynamic candidate that wants to reach a model-facing prompt is first
 * projected into a `ContextPresentation`. The projection answers one question:
 * **given how well we can currently corroborate this claim, what is the
 * strongest form we are allowed to present it in?**
 *
 * Two ceilings apply simultaneously and the mapper always takes the lower:
 *   - `sourceTier` — the evidence and applicability of the claim itself
 *   - `epistemicCeiling` — what the upstream Opportunity owner already admitted
 *
 * `sourceTier` is NOT search rank and NOT transport authority. A typed callback
 * envelope may be T0 while a historical candidate it happens to carry is T2;
 * different authorities must be projected separately.
 */

export type SourceRevision = Readonly<{ kind: 'version'; value: string } | { kind: 'as_of'; value: number }>;

export interface InvalidatorRef {
  readonly owner: string;
  readonly ref: string;
}

export type SourceTier = 'T0' | 'T1' | 'T2' | 'invalid';

/** Strongest → weakest. `omit` is a real outcome, not a failure. */
export type PresentationKind = 'directive' | 'state' | 'pointer' | 'omit';

/** What an upstream Opportunity owner already capped this envelope at. */
export type OpportunityEpistemicCeiling = 'mechanical_observation' | 'state' | 'pointer';

export type PresentationSurface = 'native_l0' | 'dynamic_context' | 'pointer' | 'deferred_queue';

export type OpportunityConsumerScope =
  | Readonly<{
      kind: 'invocation';
      ownerUserId: string;
      threadId: string;
      invocationId: string;
    }>
  | Readonly<{
      kind: 'cat';
      ownerUserId: string;
      threadId: string;
      consumerCatId: string;
    }>;

/**
 * The content-free admission facts F296 is allowed to consume from an
 * Opportunity owner. This is deliberately metadata-only: no disposition,
 * canonical state, candidate body, or producer-owned business truth fits here.
 */
export interface AdmittedOpportunityPresentationV1 {
  readonly opportunityId: string;
  readonly opportunityKind: 'write' | 'recall';
  readonly producerOwner: string;
  readonly consumerScope: OpportunityConsumerScope;
  readonly entryVersion: string;
  readonly subjectKey: string;
  readonly asOf: SourceRevision;
  readonly sourceRefs: readonly string[];
  readonly eligibleSurfaces: readonly PresentationSurface[];
  readonly presentationPolicyRef: string;
  readonly tokenBudget: number;
  readonly dedupeKey: string;
  readonly expiresAt: number;
  readonly invalidators: readonly InvalidatorRef[];
  readonly epistemicCeiling: OpportunityEpistemicCeiling;
}

interface PresentationIdentity {
  readonly subjectKey: string;
  readonly asOf: SourceRevision;
}

export type ContextPresentation =
  | (PresentationIdentity & {
      readonly sourceTier: 'T0';
      readonly invalidator?: InvalidatorRef;
      readonly presentation: 'directive' | 'state' | 'pointer' | 'omit';
      readonly claimKind?: 'mechanical_observation';
    })
  | (PresentationIdentity & {
      readonly sourceTier: 'T1';
      /** Required: a state claim with no way to become false is not a state claim. */
      readonly invalidator: InvalidatorRef;
      readonly presentation: 'state' | 'pointer' | 'omit';
      readonly claimKind?: 'mechanical_observation';
    })
  | (PresentationIdentity & {
      readonly sourceTier: 'T2';
      readonly invalidator?: InvalidatorRef;
      readonly presentation: 'pointer' | 'omit';
    })
  | (PresentationIdentity & {
      readonly sourceTier: 'invalid';
      readonly invalidator?: InvalidatorRef;
      readonly presentation: 'omit';
    });

const RANK: Readonly<Record<PresentationKind, number>> = Object.freeze({
  omit: 0,
  pointer: 1,
  state: 2,
  directive: 3,
});

const TIER_CEILING: Readonly<Record<SourceTier, PresentationKind>> = Object.freeze({
  T0: 'directive',
  T1: 'state',
  T2: 'pointer',
  invalid: 'omit',
});

const OPPORTUNITY_CEILING: Readonly<Record<OpportunityEpistemicCeiling, PresentationKind>> = Object.freeze({
  // "The system mechanically observed X" is a statement, never an instruction —
  // and it must carry claimKind so it cannot be read as intent or importance.
  mechanical_observation: 'state',
  state: 'state',
  pointer: 'pointer',
});

function weakest(...kinds: readonly PresentationKind[]): PresentationKind {
  return kinds.reduce((lowest, kind) => (RANK[kind] < RANK[lowest] ? kind : lowest));
}

export interface PresentationCandidate {
  readonly subjectKey: string;
  readonly asOf: SourceRevision;
  readonly sourceTier: SourceTier;
  readonly invalidator?: InvalidatorRef;
  /** What the producer would like. Never raises the ceiling, only lowers. */
  readonly requested: PresentationKind;
  /** Present only for admitted Opportunity envelopes. */
  readonly epistemicCeiling?: OpportunityEpistemicCeiling;
}

/**
 * Typed handoff from a dynamic producer to the provider presentation boundary.
 * The producer supplies bytes plus a candidate; only the central mapper may turn
 * that candidate into a ContextPresentation, and only the ledger may admit it.
 */
export interface ContextPresentationEnvelope<TReceipt> {
  readonly candidate: PresentationCandidate;
  /** Proof that the producer owner admitted this opportunity for presentation. */
  readonly admission: AdmittedOpportunityPresentationV1;
  /**
   * Bytes are keyed by the mapper's effective decision. A producer may offer
   * weaker renderings, but the provider boundary selects exactly one after
   * mapping; it never forwards a producer's preferred body unchanged.
   */
  readonly segments: Readonly<Partial<Record<Exclude<PresentationKind, 'omit'>, string>>>;
  readonly receipt: TReceipt;
}

/**
 * The single admission point. A producer cannot inject dynamic body text without
 * coming through here, and coming through here cannot yield something stronger
 * than the weakest applicable ceiling.
 */
export function mapToPresentation(candidate: PresentationCandidate): ContextPresentation {
  const identity = { subjectKey: candidate.subjectKey, asOf: candidate.asOf } as const;

  // A T1 claim without an invalidator has no way to ever become false. That is
  // not a verified state — it is an assertion wearing a state's clothes.
  const effectiveTier: SourceTier =
    candidate.sourceTier === 'T1' && !candidate.invalidator ? 'invalid' : candidate.sourceTier;

  const ceilings: PresentationKind[] = [TIER_CEILING[effectiveTier], candidate.requested];
  if (candidate.epistemicCeiling) ceilings.push(OPPORTUNITY_CEILING[candidate.epistemicCeiling]);
  const presentation = weakest(...ceilings);

  const carriesMechanicalClaim = candidate.epistemicCeiling === 'mechanical_observation' && presentation === 'state';

  switch (effectiveTier) {
    case 'T0':
      return {
        ...identity,
        sourceTier: 'T0',
        ...(candidate.invalidator ? { invalidator: candidate.invalidator } : {}),
        presentation,
        ...(carriesMechanicalClaim ? { claimKind: 'mechanical_observation' as const } : {}),
      };
    case 'T1':
      return {
        ...identity,
        sourceTier: 'T1',
        // Narrowed above: effectiveTier stays T1 only when the invalidator exists.
        invalidator: candidate.invalidator as InvalidatorRef,
        presentation: presentation === 'directive' ? 'state' : presentation,
        ...(carriesMechanicalClaim ? { claimKind: 'mechanical_observation' as const } : {}),
      };
    case 'T2':
      return {
        ...identity,
        sourceTier: 'T2',
        ...(candidate.invalidator ? { invalidator: candidate.invalidator } : {}),
        presentation: presentation === 'pointer' ? 'pointer' : 'omit',
      };
    case 'invalid':
      return {
        ...identity,
        sourceTier: 'invalid',
        ...(candidate.invalidator ? { invalidator: candidate.invalidator } : {}),
        presentation: 'omit',
      };
    default: {
      const exhaustive: never = effectiveTier;
      throw new Error(`unhandled source tier: ${String(exhaustive)}`);
    }
  }
}
