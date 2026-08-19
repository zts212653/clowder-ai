import { createHash } from 'node:crypto';
import type { ActionSuccessorClaimOrigin, ActionSuccessorMode, ReviewReentry } from '@cat-cafe/shared';
import {
  type CanonicalActionTerminalPredicate,
  isMachineCheckableCompletionEvidenceRef,
} from './ActionTerminalPredicateCatalog.js';
import { recordActionSuccessorOutcome } from './action-successor-outcome-state-machine.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export interface ActionCompletionCandidateSnapshot {
  evidenceRefs: string[];
  candidateRevision: number;
  evidenceDigest: string;
  recordedAt: number;
}

export type ActionCompletionTruthVerdict =
  | {
      status: 'verified';
      evidenceRef: string;
      predicateDigest: string;
      freshnessKey: string;
    }
  | { status: 'mismatch' | 'insufficient'; reason: string };

export type ActionCompletionVerdict =
  | (Extract<ActionCompletionTruthVerdict, { status: 'verified' }> &
      Pick<ActionCompletionCandidateSnapshot, 'candidateRevision' | 'evidenceDigest'>)
  | Exclude<ActionCompletionTruthVerdict, { status: 'verified' }>;

export function canonicalizeActionCompletionEvidenceRefs(evidenceRefs: readonly string[]): string[] {
  const normalized = [...new Set(evidenceRefs.map((ref) => ref.trim()).filter(Boolean))].sort();
  if (normalized.length === 0 || normalized.some((ref) => !isMachineCheckableCompletionEvidenceRef(ref))) {
    throw new Error('completion candidate requires machine-checkable completion evidence');
  }
  return normalized;
}

export function digestActionCompletionEvidence(evidenceRefs: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(evidenceRefs)).digest('hex');
}

export function createActionCompletionCandidateSnapshot(input: {
  evidenceRefs: readonly string[];
  candidateRevision: number;
  recordedAt: number;
}): ActionCompletionCandidateSnapshot {
  if (!Number.isSafeInteger(input.candidateRevision) || input.candidateRevision < 1) {
    throw new Error('completion candidate revision must be a positive integer');
  }
  const evidenceRefs = canonicalizeActionCompletionEvidenceRefs(input.evidenceRefs);
  return {
    evidenceRefs,
    candidateRevision: input.candidateRevision,
    evidenceDigest: digestActionCompletionEvidence(evidenceRefs),
    recordedAt: input.recordedAt,
  };
}

export function bindActionCompletionVerdict(
  verdict: ActionCompletionTruthVerdict,
  candidate: ActionCompletionCandidateSnapshot,
): ActionCompletionVerdict {
  return verdict.status === 'verified'
    ? {
        ...verdict,
        candidateRevision: candidate.candidateRevision,
        evidenceDigest: candidate.evidenceDigest,
      }
    : verdict;
}

export function recordActionCompletionCandidate(
  current: ActionSuccessorLease,
  input: { generation: number; catId: string; evidenceRefs: string[]; now: number },
): ActionSuccessorLease {
  if (input.generation !== current.generation) throw new Error('stale action successor generation');
  if (current.status !== 'active') throw new Error('action successor lease is not active');
  if (!current.terminalPredicate) throw new Error('action successor terminal predicate is unavailable');
  if (!current.holderCatIds.includes(input.catId)) {
    throw new Error(`cat is not an action successor holder: ${input.catId}`);
  }
  if (current.holderOutcomes[input.catId]) throw new Error('action successor holder already has a terminal outcome');
  const currentCandidate = current.completionCandidates[input.catId];
  const evidenceRefs = canonicalizeActionCompletionEvidenceRefs([
    ...(currentCandidate?.evidenceRefs ?? []),
    ...input.evidenceRefs,
  ]);
  if (currentCandidate?.evidenceDigest === digestActionCompletionEvidence(evidenceRefs)) return current;
  const candidate = createActionCompletionCandidateSnapshot({
    evidenceRefs,
    candidateRevision: (currentCandidate?.candidateRevision ?? 0) + 1,
    recordedAt: input.now,
  });
  return {
    ...current,
    completionCandidates: {
      ...current.completionCandidates,
      [input.catId]: candidate,
    },
    evidenceRefs: [...new Set([...current.evidenceRefs, ...evidenceRefs])].sort(),
    revision: current.revision + 1,
    updatedAt: input.now,
  };
}

export function commitActionCompletionVerdict(
  current: ActionSuccessorLease,
  input: { generation: number; catId: string; verdict: ActionCompletionVerdict; now: number },
): ActionSuccessorLease {
  if (input.generation !== current.generation) throw new Error('stale action successor generation');
  if (current.status !== 'active') throw new Error('action successor lease is not active');
  if (input.verdict.status !== 'verified') throw new Error('action success requires a verified completion verdict');
  if (current.holderOutcomes[input.catId]) throw new Error('action successor holder already has a terminal outcome');
  const predicate = current.terminalPredicate;
  const candidate = current.completionCandidates[input.catId];
  if (!predicate || !candidate) {
    throw new Error('matching completion candidate is required');
  }
  if (
    input.verdict.candidateRevision !== candidate.candidateRevision ||
    input.verdict.evidenceDigest !== candidate.evidenceDigest
  ) {
    throw new Error('completion candidate changed after verdict resolution');
  }
  if (
    input.verdict.predicateDigest !== predicate.digest ||
    input.verdict.freshnessKey !== predicate.freshnessKey ||
    !candidate.evidenceRefs.includes(input.verdict.evidenceRef)
  ) {
    throw new Error('completion verdict does not match the frozen predicate and candidate evidence');
  }
  const completed = recordActionSuccessorOutcome(current, {
    generation: input.generation,
    catId: input.catId,
    outcome: 'succeeded',
    evidenceRef: input.verdict.evidenceRef,
    now: input.now,
  });
  const completionCandidates = { ...completed.completionCandidates };
  delete completionCandidates[input.catId];
  return { ...completed, completionCandidates };
}

export type ContinueActionSuccessorFreshRevisionResult = {
  outcome:
    | 'continued'
    | 'subject_terminal'
    | 'stale_generation'
    | 'lease_not_completed'
    | 'predicate_identity_mismatch'
    | 'freshness_unchanged';
  lease: ActionSuccessorLease;
};

export interface ContinueActionSuccessorFreshRevisionInput {
  expectedGeneration: number;
  terminalPredicate: CanonicalActionTerminalPredicate;
  holderCatIds: string[];
  holderThreadId: string;
  claimOrigin: ActionSuccessorClaimOrigin;
  predecessorCatId?: string;
  predecessorThreadId?: string;
  dispatchId: string;
  issuerStandingEvidenceRef: string;
  evidenceRef: string;
  reviewReentry?: ReviewReentry;
  now: number;
}

function reviewReentryEvidenceRefs(reviewReentry: ReviewReentry | undefined): string[] {
  if (!reviewReentry) return [];
  return [`review-reentry:${reviewReentry.reason}:${reviewReentry.evidenceRef}`];
}

function normalizeHolders(mode: ActionSuccessorMode, holderCatIds: string[], parallelIntent?: string): string[] {
  const holders = [...new Set(holderCatIds.map((catId) => catId.trim()).filter(Boolean))];
  if (holders.length !== holderCatIds.length) throw new Error('holderCatIds must be unique and non-empty');
  if (mode === 'single' && holders.length !== 1) throw new Error('single mode requires exactly one holder');
  if (mode === 'parallel' && holders.length < 2) throw new Error('parallel mode requires at least two holders');
  if (mode === 'parallel' && !parallelIntent?.trim()) {
    throw new Error('parallel mode requires explicit parallel intent');
  }
  return holders;
}

function requireNonEmpty(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  return normalized;
}

function resolveFreshRevisionPredecessor(input: {
  claimOrigin: ActionSuccessorClaimOrigin;
  mode: ActionSuccessorMode;
  predecessorCatId: string | undefined;
  predecessorThreadId: string | undefined;
}): { predecessorCatId?: string; predecessorThreadId?: string } {
  const predecessorCatId = input.predecessorCatId?.trim();
  const predecessorThreadId = input.predecessorThreadId?.trim();
  if (input.claimOrigin === 'structured_transfer') {
    if (!predecessorCatId || !predecessorThreadId) {
      throw new Error('structured fresh revision requires predecessor route');
    }
    return { predecessorCatId, predecessorThreadId };
  }
  if (input.mode !== 'single') throw new Error('existing-standing fresh revision requires single mode');
  if (predecessorCatId || predecessorThreadId) {
    throw new Error('existing-standing fresh revision cannot declare a predecessor route');
  }
  return {};
}

export function continueActionSuccessorFreshRevision(
  current: ActionSuccessorLease,
  input: ContinueActionSuccessorFreshRevisionInput,
): ContinueActionSuccessorFreshRevisionResult {
  if (input.expectedGeneration !== current.generation) return { outcome: 'stale_generation', lease: current };
  if (current.status !== 'completed') return { outcome: 'lease_not_completed', lease: current };
  if (current.terminalPredicate && current.terminalPredicate.identityKey !== input.terminalPredicate.identityKey) {
    return { outcome: 'predicate_identity_mismatch', lease: current };
  }
  if (current.terminalPredicate?.freshnessKey === input.terminalPredicate.freshnessKey) {
    return { outcome: 'freshness_unchanged', lease: current };
  }
  const holderCatIds = normalizeHolders(current.mode, input.holderCatIds, current.parallelIntent);
  const holderThreadId = requireNonEmpty(input.holderThreadId, 'holderThreadId');
  const evidenceRef = requireNonEmpty(input.evidenceRef, 'evidenceRef');
  const issuerStandingEvidenceRef = requireNonEmpty(input.issuerStandingEvidenceRef, 'issuerStandingEvidenceRef');
  const predecessor = resolveFreshRevisionPredecessor({
    claimOrigin: input.claimOrigin,
    mode: current.mode,
    predecessorCatId: input.predecessorCatId,
    predecessorThreadId: input.predecessorThreadId,
  });
  return {
    outcome: 'continued',
    lease: {
      ...current,
      holderCatIds,
      holderThreadId,
      claimOrigin: input.claimOrigin,
      predecessorCatId: predecessor.predecessorCatId,
      predecessorThreadId: predecessor.predecessorThreadId,
      issuerStandingEvidenceRef,
      dispatchId: input.dispatchId,
      generation: current.generation + 1,
      status: 'active',
      holderOutcomes: {},
      terminalPredicateState: { kind: 'predicate_backed' },
      terminalPredicate: input.terminalPredicate,
      completionCandidates: {},
      evidenceRefs: [
        ...new Set([
          ...current.evidenceRefs,
          issuerStandingEvidenceRef,
          evidenceRef,
          ...reviewReentryEvidenceRefs(input.reviewReentry),
        ]),
      ],
      returnDeliveryState: undefined,
      returnDeliveryEvidenceRef: undefined,
      revision: current.revision + 1,
      updatedAt: input.now,
    },
  };
}
