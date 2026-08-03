import type { ActionSubjectTerminalTruth } from './ActionSuccessorLeaseStore.js';
import { createActionCompletionCandidateSnapshot } from './action-successor-completion-state-machine.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export function parseActionSuccessorLease(raw: string | null): ActionSuccessorLease | null {
  if (!raw) return null;
  const persisted = JSON.parse(raw) as Omit<ActionSuccessorLease, 'completionCandidates' | 'terminalPredicateState'> & {
    terminalPredicateState?: { kind?: string };
    completionCandidates?: Record<
      string,
      Partial<ActionSuccessorLease['completionCandidates'][string]> & { evidenceRefs: string[]; recordedAt: number }
    >;
    completionCandidate?: { catId: string; evidenceRefs: string[]; recordedAt: number };
  };
  const { completionCandidate, terminalPredicateState: persistedPredicateState, ...lease } = persisted;
  if (!lease.leaseId || !lease.key || !lease.subjectRef || typeof lease.generation !== 'number') {
    throw new Error('invalid persisted action successor lease');
  }
  // Rolling reads canonicalize old records without inventing custody or
  // retaining the retired singleton candidate as a second source of truth.
  const persistedCandidates =
    lease.completionCandidates ??
    (completionCandidate
      ? {
          [completionCandidate.catId]: completionCandidate,
        }
      : {});
  const completionCandidates = Object.fromEntries(
    Object.entries(persistedCandidates).map(([catId, candidate]) => {
      const normalized = createActionCompletionCandidateSnapshot({
        evidenceRefs: candidate.evidenceRefs,
        candidateRevision: candidate.candidateRevision ?? 1,
        recordedAt: candidate.recordedAt,
      });
      if (candidate.evidenceDigest && candidate.evidenceDigest !== normalized.evidenceDigest) {
        throw new Error('invalid persisted action completion candidate digest');
      }
      return [catId, normalized];
    }),
  );
  const base = {
    ...lease,
    claimOrigin: lease.claimOrigin ?? 'structured_transfer',
    holderThreadId: lease.holderThreadId ?? 'legacy:unknown',
    issuerStandingEvidenceRef: lease.issuerStandingEvidenceRef ?? lease.evidenceRefs[0] ?? 'legacy:unknown',
    completionCandidates,
    returnTransitions: lease.returnTransitions ?? [],
  };
  const persistedPredicateKind = persistedPredicateState?.kind;
  if (
    persistedPredicateKind &&
    persistedPredicateKind !== 'predicate_backed' &&
    persistedPredicateKind !== 'legacy_predicate_absent'
  ) {
    throw new Error('invalid persisted action successor terminal predicate state');
  }
  if (lease.terminalPredicate) {
    if (persistedPredicateKind === 'legacy_predicate_absent') {
      throw new Error('persisted action successor predicate state contradicts predicate payload');
    }
    return {
      ...base,
      terminalPredicateState: { kind: 'predicate_backed' },
      terminalPredicate: lease.terminalPredicate,
    };
  }
  if (persistedPredicateKind === 'predicate_backed') {
    throw new Error('persisted predicate-backed action successor is missing its predicate payload');
  }
  return {
    ...base,
    terminalPredicateState: { kind: 'legacy_predicate_absent' },
    terminalPredicate: undefined,
  };
}

export function parseActionSubjectTerminal(raw: string | null): ActionSubjectTerminalTruth | null {
  if (!raw) return null;
  const terminal = JSON.parse(raw) as ActionSubjectTerminalTruth;
  if (!terminal.subjectRef || !terminal.state || !terminal.evidenceRef) {
    throw new Error('invalid persisted action subject terminal truth');
  }
  return terminal;
}
