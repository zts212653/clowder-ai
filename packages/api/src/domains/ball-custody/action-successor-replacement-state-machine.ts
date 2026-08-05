import type { CanonicalActionTerminalPredicate } from './ActionTerminalPredicateCatalog.js';
import {
  isReturnedActionSuccessorHolderGeneration,
  type ReturnedActionSuccessorProof,
  reattachReturnedActionSuccessor,
} from './action-successor-return-state-machine.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export type ReplaceActionSuccessorResult = {
  outcome:
    | 'replaced'
    | 'reattached'
    | 'stale_generation'
    | 'proof_required'
    | 'holder_mismatch'
    | 'return_proof_required'
    | 'candidate_present'
    | 'completion_present'
    | 'terminal_predicate_mismatch';
  lease: ActionSuccessorLease;
};

type ReplaceActionSuccessorInputBase = {
  expectedGeneration: number;
  holderCatIds: string[];
  holderThreadId: string;
  dispatchId: string;
  terminalPredicate: CanonicalActionTerminalPredicate;
  evidenceRef: string;
  freshnessEvidenceRef?: string;
  returnedHolderCatId?: string;
  returnedHolderThreadId?: string;
  returnProof?: ReturnedActionSuccessorProof;
  now: number;
};

export type ReplaceActionSuccessorInput = ReplaceActionSuccessorInputBase &
  (
    | {
        claimOrigin?: 'structured_transfer';
        predecessorCatId: string;
        predecessorThreadId: string;
        issuerStandingEvidenceRef?: string;
      }
    | {
        claimOrigin: 'existing_standing';
        predecessorCatId?: never;
        predecessorThreadId?: never;
        issuerStandingEvidenceRef: string;
      }
  );

function requireNonEmpty(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  return normalized;
}

function normalizeReplacementHolders(current: ActionSuccessorLease, holderCatIds: string[]): string[] {
  const holders = [...new Set(holderCatIds.map((catId) => catId.trim()).filter(Boolean))];
  if (holders.length !== holderCatIds.length) throw new Error('holderCatIds must be unique and non-empty');
  if (current.mode === 'single' && holders.length !== 1) throw new Error('single mode requires exactly one holder');
  if (current.mode === 'parallel' && holders.length < 2) {
    throw new Error('parallel mode requires at least two holders');
  }
  if (current.mode === 'parallel' && !current.parallelIntent?.trim()) {
    throw new Error('parallel mode requires explicit parallel intent');
  }
  return holders;
}

function replaceReturnedActionSuccessor(
  current: ActionSuccessorLease,
  input: ReplaceActionSuccessorInput,
): ReplaceActionSuccessorResult | null {
  if (!isReturnedActionSuccessorHolderGeneration(current)) return null;
  if (
    (input.claimOrigin ?? 'structured_transfer') !== 'structured_transfer' ||
    input.predecessorCatId !== input.returnedHolderCatId ||
    input.predecessorThreadId !== input.returnedHolderThreadId
  ) {
    return { outcome: 'holder_mismatch', lease: current };
  }
  if (!input.returnProof || !input.freshnessEvidenceRef) {
    return { outcome: 'return_proof_required', lease: current };
  }
  return reattachReturnedActionSuccessor(current, {
    expectedGeneration: input.expectedGeneration,
    holderCatIds: input.holderCatIds,
    holderThreadId: input.holderThreadId,
    dispatchId: input.dispatchId,
    terminalPredicate: input.terminalPredicate,
    evidenceRef: input.evidenceRef,
    freshnessEvidenceRef: input.freshnessEvidenceRef,
    returnedHolderCatId: input.returnedHolderCatId ?? '',
    returnedHolderThreadId: input.returnedHolderThreadId ?? '',
    returnProof: input.returnProof,
    now: input.now,
  });
}

export function replaceActionSuccessor(
  current: ActionSuccessorLease,
  input: ReplaceActionSuccessorInput,
): ReplaceActionSuccessorResult {
  if (input.expectedGeneration !== current.generation) return { outcome: 'stale_generation', lease: current };
  const returnedReplacement = replaceReturnedActionSuccessor(current, input);
  if (returnedReplacement) return returnedReplacement;
  if (current.status !== 'replaceable') return { outcome: 'proof_required', lease: current };
  if (!input.terminalPredicate) {
    throw new Error('terminal predicate is required for a replacement action successor generation');
  }
  const holderCatIds = normalizeReplacementHolders(current, input.holderCatIds);
  const holderThreadId = requireNonEmpty(input.holderThreadId, 'holderThreadId');
  const evidenceRef = requireNonEmpty(input.evidenceRef, 'evidenceRef');
  const claimOrigin = input.claimOrigin ?? 'structured_transfer';
  if (claimOrigin !== current.claimOrigin) {
    throw new Error('replacement claim origin must match the persisted lease');
  }
  const provenance =
    claimOrigin === 'existing_standing'
      ? (() => {
          if (current.mode !== 'single') throw new Error('existing standing requires single mode');
          if (input.predecessorCatId || input.predecessorThreadId) {
            throw new Error('existing standing cannot declare a predecessor route');
          }
          return {
            issuerStandingEvidenceRef: requireNonEmpty(input.issuerStandingEvidenceRef, 'issuerStandingEvidenceRef'),
          };
        })()
      : {
          predecessorCatId: requireNonEmpty(input.predecessorCatId, 'predecessorCatId'),
          predecessorThreadId: requireNonEmpty(input.predecessorThreadId, 'predecessorThreadId'),
          issuerStandingEvidenceRef: requireNonEmpty(
            input.issuerStandingEvidenceRef ?? evidenceRef,
            'issuerStandingEvidenceRef',
          ),
        };
  return {
    outcome: 'replaced',
    lease: {
      ...current,
      holderCatIds,
      holderThreadId,
      predecessorCatId: undefined,
      predecessorThreadId: undefined,
      ...provenance,
      claimOrigin,
      dispatchId: input.dispatchId,
      terminalPredicateState: { kind: 'predicate_backed' },
      terminalPredicate: input.terminalPredicate,
      generation: current.generation + 1,
      status: 'active',
      holderOutcomes: {},
      completionCandidates: {},
      evidenceRefs: [
        ...new Set([
          ...current.evidenceRefs,
          current.issuerStandingEvidenceRef,
          evidenceRef,
          provenance.issuerStandingEvidenceRef,
        ]),
      ],
      returnDeliveryState: undefined,
      returnDeliveryEvidenceRef: undefined,
      revision: current.revision + 1,
      updatedAt: input.now,
    },
  };
}
