import type { ActionSuccessorRequestMetadata } from '@cat-cafe/shared';
import type { ActionSubjectTerminalTruth, ActionSuccessorClaimStoreResult } from './ActionSuccessorLeaseStore.js';
import type { ActionSuccessorLease, ClaimActionSuccessorInput } from './action-successor-state-machine.js';

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
        | 'parallel_return_unsupported'
        | 'review_reentry_ineligible';
      lease: ActionSuccessorLease;
    }
  | { admit: false; outcome: 'subject_terminal'; terminal: ActionSubjectTerminalTruth };
