import type { ActionSuccessorRequestMetadata } from '@cat-cafe/shared';
import type { ActionSubjectTerminalTruth, ActionSuccessorClaimStoreResult } from './ActionSuccessorLeaseStore.js';
import type { ActionSuccessorLease, ClaimActionSuccessorInput } from './action-successor-state-machine.js';

/**
 * Server-derived proof of one direct human correction in the current execution
 * child. Request bodies may name the source message, but cannot construct this
 * proof; callback admission re-reads the persisted message and revision.
 */
export interface ActionSuccessorHumanReassignmentEvidence {
  sourceMessageId: string;
  sourceMessageRevision: string;
  evidenceRef: string;
  userId: string;
  threadId: string;
  authoredAt: number;
}

export interface ActionSuccessorAdmissionInput {
  tenantScope: string;
  actorCatId: string;
  sourceThreadId: string;
  targetThreadId: string;
  holderCatIds: string[];
  dispatchId: string;
  evidenceRef: string;
  now: number;
  incomingActionLeaseRef?: { leaseId: string; generation: number };
  /** Server-derived exact human correction; never accepted from a request body. */
  humanReassignmentEvidence?: ActionSuccessorHumanReassignmentEvidence;
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

export function actionSuccessorFencesMatch(
  candidate: ActionSuccessorFence | undefined,
  expected: ActionSuccessorFence,
): boolean {
  return (
    candidate?.leaseId === expected.leaseId &&
    candidate?.generation === expected.generation &&
    candidate?.dispatchId === expected.dispatchId &&
    candidate?.terminalPredicateDigest === expected.terminalPredicateDigest &&
    candidate?.invocationLineageRef === expected.invocationLineageRef
  );
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
      outcome: 'claimed' | 'replaced' | 'reattached' | 'returned' | 'continued';
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
        | 'return_proof_required'
        | 'candidate_present'
        | 'completion_present'
        | 'terminal_predicate_mismatch'
        | 'predecessor_missing'
        | 'parallel_return_unsupported';
      lease: ActionSuccessorLease;
    }
  | { admit: false; outcome: 'subject_terminal'; terminal: ActionSubjectTerminalTruth };
