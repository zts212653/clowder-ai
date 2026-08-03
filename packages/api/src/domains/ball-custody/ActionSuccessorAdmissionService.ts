import { randomUUID } from 'node:crypto';
import type { ActionSuccessorRequestMetadata } from '@cat-cafe/shared';
import {
  completedGenerationBlockedFreshRevisionTotal,
  successorConcurrentSuccessors,
  successorReplace,
  successorSafeWait,
  successorUniqueCatsInvokedPerAction,
} from '../../infrastructure/telemetry/instruments.js';
import type { ActionFreshnessResolution, ActionSubjectTruthResolver } from './ActionSubjectTruthResolver.js';
import type {
  ActionSubjectTerminalTruth,
  ActionSuccessorClaimStoreResult,
  ActionSuccessorLeaseStore,
} from './ActionSuccessorLeaseStore.js';
import {
  type CanonicalActionTerminalPredicate,
  canonicalizeActionTerminalPredicate,
  isDurableReviewReentryEvidenceRef,
} from './ActionTerminalPredicateCatalog.js';
import {
  type ActionSuccessorLease,
  type ClaimActionSuccessorInput,
  canonicalizeActionIdentity,
  isActionSuccessorReturnReplay,
} from './action-successor-state-machine.js';

export interface ActionSuccessorAdmissionInput {
  tenantScope: string;
  actorCatId: string;
  sourceThreadId: string;
  targetThreadId: string;
  holderCatIds: string[];
  dispatchId: string;
  evidenceRef: string;
  now: number;
  action: ActionSuccessorRequestMetadata;
}

export interface ActionSuccessorAdmissionOptions {
  /**
   * Narrow transaction override for callers that must commit another
   * canonical state transition in the same Redis script as the F167 claim.
   */
  claim?: (input: ClaimActionSuccessorInput) => Promise<ActionSuccessorClaimStoreResult>;
}

export interface ActionSuccessorFence {
  leaseId: string;
  generation: number;
  dispatchId: string;
  terminalPredicateDigest?: string;
  invocationLineageRef?: string;
}

export function buildActionSuccessorFence(lease: ActionSuccessorLease, dispatchId: string): ActionSuccessorFence {
  return {
    leaseId: lease.leaseId,
    generation: lease.generation,
    dispatchId,
    ...(lease.terminalPredicate
      ? {
          terminalPredicateDigest: lease.terminalPredicate.digest,
          invocationLineageRef: `dispatch:${dispatchId}`,
        }
      : {}),
  };
}

export type ActionSuccessorAdmissionResult =
  | {
      admit: true;
      outcome: 'claimed' | 'replaced' | 'returned' | 'continued';
      lease: ActionSuccessorLease;
      fence: ActionSuccessorFence;
    }
  | {
      admit: false;
      outcome:
        | 'safe_wait'
        | 'replayed'
        | 'replay_mismatch'
        | 'stale_generation'
        | 'proof_required'
        | 'lease_not_active'
        | 'holder_mismatch'
        | 'predecessor_missing'
        | 'parallel_return_unsupported'
        | 'review_reentry_ineligible';
      lease: ActionSuccessorLease;
    }
  | { admit: false; outcome: 'subject_terminal'; terminal: ActionSubjectTerminalTruth };

export class ActionSuccessorAdmissionService {
  constructor(
    private readonly leaseStore: Pick<
      ActionSuccessorLeaseStore,
      | 'claim'
      | 'get'
      | 'replace'
      | 'commitOutcome'
      | 'returnToPredecessor'
      | 'markReturnDelivered'
      | 'continueFreshRevision'
    >,
    private readonly truthResolver: Pick<ActionSubjectTruthResolver, 'resolve' | 'resolveFreshness'>,
  ) {}

  async markReturnedDelivered(input: { fence: ActionSuccessorFence; evidenceRef: string; now: number }): Promise<void> {
    const result = await this.leaseStore.markReturnDelivered(input.fence.leaseId, {
      expectedGeneration: input.fence.generation,
      evidenceRef: input.evidenceRef,
      now: input.now,
    });
    if (result.outcome !== 'delivered' && result.outcome !== 'return_not_pending') {
      throw new Error(`action successor return delivery rejected: ${result.outcome}`);
    }
  }

  async markUnavailable(input: {
    fence: ActionSuccessorFence;
    holderCatIds: string[];
    evidenceRef: string;
    now: number;
  }): Promise<void> {
    await Promise.all(
      input.holderCatIds.map((catId) =>
        this.leaseStore.commitOutcome(input.fence.leaseId, {
          generation: input.fence.generation,
          catId,
          outcome: 'unavailable',
          evidenceRef: input.evidenceRef,
          now: input.now,
        }),
      ),
    );
  }

  async admit(
    input: ActionSuccessorAdmissionInput,
    options?: ActionSuccessorAdmissionOptions,
  ): Promise<ActionSuccessorAdmissionResult> {
    const truth = await this.truthResolver.resolve(input.action.subjectRef, input.now);
    if (truth.terminal) return { admit: false, outcome: 'subject_terminal', terminal: truth.truth };

    const identity = canonicalizeActionIdentity({
      tenantScope: input.tenantScope,
      subjectRef: input.action.subjectRef,
      actionFamily: input.action.actionFamily,
      successorSlot: input.action.successorSlot,
    });
    if (input.action.returnToPredecessor) return this.returnToPredecessor(identity.key, input);
    if (input.action.replace) return this.replace(identity.key, input);

    const claimOrigin = input.action.claimOrigin ?? 'structured_transfer';
    const issuerStandingEvidenceRef = this.resolveIssuerStanding(input, claimOrigin);

    const terminalPredicate = this.requireTerminalPredicate(input);
    const freshness = await this.requireVerifiedGenerationFreshness(terminalPredicate);
    this.assertFreshnessStanding(input, freshness);
    const claimInput: ClaimActionSuccessorInput = {
      leaseId: randomUUID(),
      ...identity,
      mode: input.action.mode,
      holderCatIds: input.holderCatIds,
      ...(input.action.parallelIntent ? { parallelIntent: input.action.parallelIntent } : {}),
      dispatchId: input.dispatchId,
      claimOrigin,
      holderThreadId: input.targetThreadId,
      ...(claimOrigin === 'structured_transfer'
        ? { predecessorCatId: input.actorCatId, predecessorThreadId: input.sourceThreadId }
        : {}),
      issuerStandingEvidenceRef,
      evidenceRefs: [input.evidenceRef, freshness.evidenceRef],
      terminalPredicate,
      now: input.now,
    };
    const result = await (options?.claim ? options.claim(claimInput) : this.leaseStore.claim(claimInput));
    if (result.outcome === 'subject_terminal') {
      return { admit: false, outcome: 'subject_terminal', terminal: result.terminal };
    }
    if (result.outcome === 'claimed') return this.admitted('claimed', result.lease, input.dispatchId);
    const continuation =
      result.outcome === 'safe_wait'
        ? await this.tryContinueFreshRevision(
            result.lease,
            terminalPredicate,
            claimOrigin,
            issuerStandingEvidenceRef,
            input,
          )
        : null;
    if (continuation) return continuation;
    if (result.outcome === 'safe_wait') successorSafeWait.add(1);
    return { admit: false, outcome: result.outcome, lease: result.lease };
  }

  private resolveIssuerStanding(
    input: ActionSuccessorAdmissionInput,
    claimOrigin: 'structured_transfer' | 'existing_standing',
  ): string {
    if (claimOrigin === 'structured_transfer') return input.evidenceRef;
    if (input.holderCatIds.length !== 1 || input.holderCatIds[0] !== input.actorCatId) {
      throw new Error('existing-standing claim must target the authenticated actor only');
    }
    if (!input.action.groundingEvidenceRef) {
      throw new Error('existing-standing claim requires grounding evidence');
    }
    return input.action.groundingEvidenceRef;
  }

  private async tryContinueFreshRevision(
    lease: ActionSuccessorLease,
    terminalPredicate: CanonicalActionTerminalPredicate,
    claimOrigin: 'structured_transfer' | 'existing_standing',
    issuerStandingEvidenceRef: string,
    input: ActionSuccessorAdmissionInput,
  ): Promise<ActionSuccessorAdmissionResult | null> {
    if (lease.status !== 'completed') return null;
    if (lease.terminalPredicate?.identityKey !== undefined) {
      if (lease.terminalPredicate.identityKey !== terminalPredicate.identityKey) return null;
      if (lease.terminalPredicate.freshnessKey === terminalPredicate.freshnessKey) return null;
    }
    const reviewReentry = input.action.reviewReentry;
    if (
      lease.actionFamily === 'review' &&
      (!reviewReentry || !isDurableReviewReentryEvidenceRef(reviewReentry.evidenceRef))
    ) {
      completedGenerationBlockedFreshRevisionTotal.add(1, { reason: 'review_reentry_ineligible' });
      return { admit: false, outcome: 'review_reentry_ineligible', lease };
    }
    const freshness = await this.resolveGenerationFreshness(terminalPredicate);
    if (freshness.status !== 'verified') return null;
    const continued = await this.leaseStore.continueFreshRevision(lease.leaseId, {
      expectedGeneration: lease.generation,
      terminalPredicate,
      holderCatIds: input.holderCatIds,
      holderThreadId: input.targetThreadId,
      claimOrigin,
      ...(claimOrigin === 'structured_transfer'
        ? { predecessorCatId: input.actorCatId, predecessorThreadId: input.sourceThreadId }
        : {}),
      dispatchId: input.dispatchId,
      issuerStandingEvidenceRef,
      evidenceRef: freshness.evidenceRef,
      ...(reviewReentry ? { reviewReentry } : {}),
      now: input.now,
    });
    if (continued.outcome === 'continued') {
      return this.admitted('continued', continued.lease, input.dispatchId);
    }
    completedGenerationBlockedFreshRevisionTotal.add(1, { reason: continued.outcome });
    if (continued.outcome === 'subject_terminal') {
      return this.resolveTerminalCas(input, 'fresh-revision');
    }
    return null;
  }

  private async replace(
    identityKey: string,
    input: ActionSuccessorAdmissionInput,
  ): Promise<ActionSuccessorAdmissionResult> {
    const replacement = input.action.replace;
    if (!replacement) throw new Error('replacement metadata missing');
    const current = await this.leaseStore.get(replacement.leaseId);
    if (!current) throw new Error(`replacement lease not found: ${replacement.leaseId}`);
    if (current.key !== identityKey) throw new Error('replacement lease identity mismatch');
    const claimOrigin = input.action.claimOrigin ?? 'structured_transfer';
    if (current.claimOrigin !== claimOrigin) {
      throw new Error('replacement claim origin must match the persisted lease');
    }
    const issuerStandingEvidenceRef = this.resolveIssuerStanding(input, claimOrigin);
    if (claimOrigin === 'existing_standing') {
      if (current.holderThreadId !== input.sourceThreadId) {
        throw new Error('existing-standing replacement must originate from the persisted holder thread');
      }
    } else if (current.predecessorCatId !== input.actorCatId || current.predecessorThreadId !== input.sourceThreadId) {
      throw new Error('replacement must originate from the persisted issuer route');
    }
    const terminalPredicate = this.requireTerminalPredicate(input);
    const freshness = await this.requireVerifiedGenerationFreshness(terminalPredicate);
    this.assertFreshnessStanding(input, freshness);

    const replacementInput = {
      expectedGeneration: replacement.expectedGeneration,
      holderCatIds: input.holderCatIds,
      holderThreadId: input.targetThreadId,
      dispatchId: input.dispatchId,
      terminalPredicate,
      evidenceRef: input.evidenceRef,
      now: input.now,
    };
    const result = await this.leaseStore.replace(
      replacement.leaseId,
      claimOrigin === 'existing_standing'
        ? { ...replacementInput, claimOrigin, issuerStandingEvidenceRef }
        : {
            ...replacementInput,
            claimOrigin,
            predecessorCatId: input.actorCatId,
            predecessorThreadId: input.sourceThreadId,
            issuerStandingEvidenceRef,
          },
    );
    if (result.outcome === 'replaced') {
      successorReplace.add(1);
      return this.admitted('replaced', result.lease, input.dispatchId);
    }
    if (result.outcome === 'subject_terminal') return this.resolveTerminalCas(input, 'replacement');
    return { admit: false, outcome: result.outcome, lease: result.lease };
  }

  private requireTerminalPredicate(input: ActionSuccessorAdmissionInput): CanonicalActionTerminalPredicate {
    if (!input.action.terminalPredicate) {
      throw new Error('terminal predicate is required for a new action successor generation');
    }
    return canonicalizeActionTerminalPredicate({
      actionFamily: input.action.actionFamily,
      subjectRef: input.action.subjectRef,
      predicate: input.action.terminalPredicate,
    });
  }

  private async resolveGenerationFreshness(
    terminalPredicate: CanonicalActionTerminalPredicate,
  ): Promise<ActionFreshnessResolution> {
    const freshness = await this.truthResolver.resolveFreshness(terminalPredicate);
    if (freshness.status === 'verified' && freshness.freshnessKey !== terminalPredicate.freshnessKey) {
      return { status: 'mismatch', reason: 'verified freshness identity does not match the canonical predicate' };
    }
    return freshness;
  }

  private async requireVerifiedGenerationFreshness(
    terminalPredicate: CanonicalActionTerminalPredicate,
  ): Promise<Extract<ActionFreshnessResolution, { status: 'verified' }>> {
    const freshness = await this.resolveGenerationFreshness(terminalPredicate);
    if (freshness.status !== 'verified') {
      throw new Error(`action successor freshness rejected: ${freshness.status}: ${freshness.reason}`);
    }
    return freshness;
  }

  private assertFreshnessStanding(
    input: ActionSuccessorAdmissionInput,
    freshness: Extract<ActionFreshnessResolution, { status: 'verified' }>,
  ): void {
    const ownerMatches =
      freshness.ownerCatId === undefined ||
      (input.holderCatIds.length === 1 && input.holderCatIds[0] === freshness.ownerCatId);
    const threadMatches = freshness.holderThreadId === undefined || input.targetThreadId === freshness.holderThreadId;
    const tenantMatches = freshness.tenantScope === undefined || input.tenantScope === freshness.tenantScope;
    if (!ownerMatches || !threadMatches || !tenantMatches) {
      throw new Error('task standing does not match the persisted owner, tenant, and task thread');
    }
  }

  private async returnToPredecessor(
    identityKey: string,
    input: ActionSuccessorAdmissionInput,
  ): Promise<ActionSuccessorAdmissionResult> {
    const metadata = input.action.returnToPredecessor;
    if (!metadata) throw new Error('return-to-predecessor metadata missing');
    const current = await this.leaseStore.get(metadata.leaseId);
    if (!current) throw new Error(`return lease not found: ${metadata.leaseId}`);
    if (current.key !== identityKey) throw new Error('return lease identity mismatch');
    const returnInput = {
      expectedGeneration: metadata.expectedGeneration,
      rejectingCatId: input.actorCatId,
      rejectingThreadId: input.sourceThreadId,
      dispatchId: input.dispatchId,
      groundingEvidenceRef: metadata.groundingEvidenceRef,
      now: input.now,
    };
    const replayed = isActionSuccessorReturnReplay(current, returnInput);
    const replayTransition = replayed ? (current.returnTransitions ?? []).at(-1) : undefined;
    const targetCatId = replayTransition?.predecessorCatId ?? current.predecessorCatId;
    const targetThreadId = replayTransition?.predecessorThreadId ?? current.predecessorThreadId;
    if (!targetCatId || input.holderCatIds.length !== 1 || input.holderCatIds[0] !== targetCatId) {
      throw new Error('return target must match the persisted predecessor cat');
    }
    if (!targetThreadId || input.targetThreadId !== targetThreadId) {
      throw new Error('return target thread must match the persisted predecessor thread');
    }
    const rejectingThreadId = replayed ? current.predecessorThreadId : current.holderThreadId;
    if (rejectingThreadId !== input.sourceThreadId) {
      throw new Error('return must originate from the persisted holder thread');
    }

    const result = await this.leaseStore.returnToPredecessor(metadata.leaseId, returnInput);
    if (result.outcome === 'returned') return this.admitted('returned', result.lease, input.dispatchId);
    if (result.outcome === 'subject_terminal') return this.resolveTerminalCas(input, 'return');
    return { admit: false, outcome: result.outcome, lease: result.lease };
  }

  private async resolveTerminalCas(
    input: ActionSuccessorAdmissionInput,
    operation: string,
  ): Promise<Extract<ActionSuccessorAdmissionResult, { outcome: 'subject_terminal' }>> {
    const terminal = await this.truthResolver.resolve(input.action.subjectRef, input.now);
    if (terminal.terminal) return { admit: false, outcome: 'subject_terminal', terminal: terminal.truth };
    throw new Error(`${operation} CAS reported subject_terminal without durable terminal truth`);
  }

  private admitted(
    outcome: 'claimed' | 'replaced' | 'returned' | 'continued',
    lease: ActionSuccessorLease,
    dispatchId: string,
  ): ActionSuccessorAdmissionResult {
    const attributes = { 'action_successor.mode': lease.mode };
    successorUniqueCatsInvokedPerAction.record(lease.holderCatIds.length, attributes);
    successorConcurrentSuccessors.record(lease.holderCatIds.length, attributes);
    return {
      admit: true,
      outcome,
      lease,
      fence: buildActionSuccessorFence(lease, dispatchId),
    };
  }
}
