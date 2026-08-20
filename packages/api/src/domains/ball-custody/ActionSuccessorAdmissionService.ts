import { randomUUID } from 'node:crypto';
import {
  completedGenerationBlockedFreshRevisionTotal,
  successorConcurrentSuccessors,
  successorSafeWait,
  successorUniqueCatsInvokedPerAction,
} from '../../infrastructure/telemetry/instruments.js';
import type { ActionFreshnessResolution, ActionSubjectTruthResolver } from './ActionSubjectTruthResolver.js';
import {
  type ActionSuccessorAdmissionInput,
  type ActionSuccessorAdmissionOptions,
  type ActionSuccessorAdmissionResult,
  type ActionSuccessorFence,
  buildActionSuccessorFence,
} from './ActionSuccessorAdmissionContract.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import { admitActionSuccessorReplacement } from './ActionSuccessorReplacementAdmission.js';
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

export type {
  ActionSuccessorAdmissionInput,
  ActionSuccessorAdmissionOptions,
  ActionSuccessorAdmissionResult,
  ActionSuccessorFence,
} from './ActionSuccessorAdmissionContract.js';
export { buildActionSuccessorFence } from './ActionSuccessorAdmissionContract.js';

export type ActionSuccessorStandingMismatchDimension = 'owner' | 'target_thread' | 'tenant';

export class ActionSuccessorStandingError extends Error {
  constructor(
    readonly status: 'mismatch' | 'insufficient',
    readonly reason: string,
    readonly mismatchDimensions: readonly ActionSuccessorStandingMismatchDimension[] = [],
  ) {
    super(`action successor freshness rejected: ${status}: ${reason}`);
    this.name = 'ActionSuccessorStandingError';
  }
}

type ActionSuccessorStandingInput = Pick<
  ActionSuccessorAdmissionInput,
  'action' | 'holderCatIds' | 'targetThreadId' | 'tenantScope'
>;

export function assertActionSuccessorStanding(
  input: ActionSuccessorStandingInput,
  freshness: Extract<ActionFreshnessResolution, { status: 'verified' }>,
): void {
  const mismatchDimensions: ActionSuccessorStandingMismatchDimension[] = [];
  if (
    freshness.ownerCatId !== undefined &&
    (input.holderCatIds.length !== 1 || input.holderCatIds[0] !== freshness.ownerCatId)
  ) {
    mismatchDimensions.push('owner');
  }
  if (freshness.holderThreadId !== undefined && input.targetThreadId !== freshness.holderThreadId) {
    mismatchDimensions.push('target_thread');
  }
  if (freshness.tenantScope !== undefined && input.tenantScope !== freshness.tenantScope) {
    mismatchDimensions.push('tenant');
  }
  if (mismatchDimensions.length > 0) {
    throw new ActionSuccessorStandingError(
      'mismatch',
      'task standing does not match the persisted owner, tenant, and task thread',
      mismatchDimensions,
    );
  }
}

export type LocalReviewTerminalRoutePreflight =
  | { applicable: false }
  | { applicable: true; allow: true; expectedThreadId: string }
  | {
      applicable: true;
      allow: false;
      reason:
        | 'generation_mismatch'
        | 'reviewer_not_holder'
        | 'holder_thread_mismatch'
        | 'predecessor_route_missing'
        | 'target_thread_mismatch';
      expectedThreadId?: string;
    };

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

  /**
   * Read-only standing preflight for an initial structured transfer. F246 calls
   * this before proposal persistence; F167 calls the same assertion again at
   * lease admission so the approval window cannot weaken durable task truth.
   */
  async preflightStructuredTransferStanding(
    input: ActionSuccessorStandingInput,
  ): Promise<Extract<ActionFreshnessResolution, { status: 'verified' }>> {
    const terminalPredicate = this.requireTerminalPredicate(input);
    const freshness = await this.requireVerifiedGenerationFreshness(terminalPredicate);
    assertActionSuccessorStanding(input, freshness);
    return freshness;
  }

  /**
   * A local-review terminal carrier returns to the thread that directly issued
   * the review lease. Task ancestry and older coordination provenance are not
   * delivery authority. This runs before callback persistence.
   */
  async preflightLocalReviewTerminalRoute(input: {
    leaseId: string;
    generation: number;
    reviewerCatId: string;
    holderThreadId: string;
    targetThreadId: string;
  }): Promise<LocalReviewTerminalRoutePreflight> {
    const lease = await this.leaseStore.get(input.leaseId);
    // Without the lease there is no authoritative action-family evidence. Do
    // not misclassify an unknown/non-review terminal as a review route error;
    // the callback's other carrier and terminal guards remain in force.
    if (!lease) return { applicable: false };
    if (lease.actionFamily !== 'review' || lease.successorSlot !== 'reviewer') return { applicable: false };

    const expectedThreadId = lease.predecessorThreadId;
    if (lease.generation !== input.generation) {
      return {
        applicable: true,
        allow: false,
        reason: 'generation_mismatch',
        ...(expectedThreadId ? { expectedThreadId } : {}),
      };
    }
    if (!lease.holderCatIds.includes(input.reviewerCatId)) {
      return {
        applicable: true,
        allow: false,
        reason: 'reviewer_not_holder',
        ...(expectedThreadId ? { expectedThreadId } : {}),
      };
    }
    if (lease.holderThreadId !== input.holderThreadId) {
      return {
        applicable: true,
        allow: false,
        reason: 'holder_thread_mismatch',
        ...(expectedThreadId ? { expectedThreadId } : {}),
      };
    }
    if (!expectedThreadId) {
      return { applicable: true, allow: false, reason: 'predecessor_route_missing' };
    }
    if (input.targetThreadId !== expectedThreadId) {
      return {
        applicable: true,
        allow: false,
        reason: 'target_thread_mismatch',
        expectedThreadId,
      };
    }
    return { applicable: true, allow: true, expectedThreadId };
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
    assertActionSuccessorStanding(input, freshness);
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
    return admitActionSuccessorReplacement(identityKey, input, {
      leaseStore: this.leaseStore,
      resolveIssuerStanding: (request, claimOrigin) => this.resolveIssuerStanding(request, claimOrigin),
      resolveVerifiedPredicate: async (request) => {
        const terminalPredicate = this.requireTerminalPredicate(request);
        const freshness = await this.requireVerifiedGenerationFreshness(terminalPredicate);
        assertActionSuccessorStanding(request, freshness);
        return { terminalPredicate, freshnessEvidenceRef: freshness.evidenceRef };
      },
      admitted: (outcome, lease, dispatchId) => this.admitted(outcome, lease, dispatchId),
      resolveTerminalCas: (request) => this.resolveTerminalCas(request, 'replacement'),
    });
  }

  private requireTerminalPredicate(
    input: Pick<ActionSuccessorAdmissionInput, 'action'>,
  ): CanonicalActionTerminalPredicate {
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
      throw new ActionSuccessorStandingError(freshness.status, freshness.reason);
    }
    return freshness;
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
    outcome: 'claimed' | 'replaced' | 'reattached' | 'returned' | 'continued',
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
