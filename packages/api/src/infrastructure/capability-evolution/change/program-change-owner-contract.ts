import type { EvolutionCycleDecision, OwnerTruthRefV1 } from '@cat-cafe/shared';
import type { ExactAssetVersionRefV1 } from './program-lineage.js';

export type EvolutionChangeRefs = {
  caseRef: OwnerTruthRefV1;
  proposalRef: OwnerTruthRefV1;
  ownerAuthorizationRef: OwnerTruthRefV1;
  targetVersionRef: ExactAssetVersionRefV1;
};

/**
 * Authentication-grade origin for F266 proposal ingress. It is derived from the verified callback
 * record and is never accepted from a Program request body or reconstructed by an adapter.
 */
export interface EvolutionChangeRequestAuthority {
  invocationId: string;
  userId: string;
  catId: string;
  threadId: string;
  originMessageId: string;
}

/**
 * A metabolism verdict stays with the value owner. The browser is the direct owner surface; a cat
 * may only carry an exact owner-source invocation for the canonical owner to verify. Persistent
 * agent identity alone is deliberately insufficient.
 */
export type EvolutionValueDecisionAuthority =
  | { kind: 'owner_session'; userId: string }
  | ({ kind: 'owner_source' } & EvolutionChangeRequestAuthority);

export interface EvolutionChangeOwnerSnapshot extends EvolutionChangeRefs {
  status:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'withdrawn'
    | 'superseded'
    | 'target_drift'
    | 'mutated'
    | 'no_change'
    | 'outcome';
  approvalRef?: OwnerTruthRefV1;
  decisionRef?: OwnerTruthRefV1;
  interventionReceiptRef?: OwnerTruthRefV1;
  assetVersionRef?: ExactAssetVersionRefV1;
  loadedRuntimeRef?: OwnerTruthRefV1;
  outcomeReceiptRef?: OwnerTruthRefV1;
  freshnessProofRef?: OwnerTruthRefV1;
  changedAt?: string;
  loadedAt?: string;
  recordedAt?: string;
  measuredAt?: string;
}

export interface EvolutionChangeOwnerBlocked {
  status: 'blocked';
  reason: string;
  blockerRef?: OwnerTruthRefV1;
}

/**
 * Ref-only boundary implemented by F266/F313 and the canonical asset owner. Permission payloads,
 * Approval state, dispatch custody, mutations and outcomes never cross into F311.
 */
export interface EvolutionChangeOwnerPort {
  requestApproval(input: {
    programRef: OwnerTruthRefV1;
    cycleRef: OwnerTruthRefV1;
    interventionRef: OwnerTruthRefV1;
    clientMessageId: string;
    requestAuthority: EvolutionChangeRequestAuthority;
  }): Promise<({ status: 'pending' } & EvolutionChangeRefs) | EvolutionChangeOwnerBlocked>;
  resolveChange(
    input: Pick<EvolutionChangeRefs, 'caseRef' | 'proposalRef'>,
  ): Promise<EvolutionChangeOwnerSnapshot | EvolutionChangeOwnerBlocked>;
  recordMetabolismDecision(input: {
    programRef: OwnerTruthRefV1;
    cycleRef: OwnerTruthRefV1;
    caseRef: OwnerTruthRefV1;
    proposalRef: OwnerTruthRefV1;
    outcomeReceiptRef: OwnerTruthRefV1;
    decision: Exclude<EvolutionCycleDecision, 'insufficient'>;
    clientMessageId: string;
    decisionAuthority: EvolutionValueDecisionAuthority;
  }): Promise<
    | {
        status: 'recorded' | 'duplicate';
        decisionRef: OwnerTruthRefV1;
        executionReceiptRef?: OwnerTruthRefV1;
        assetVersionRef?: ExactAssetVersionRefV1;
      }
    | EvolutionChangeOwnerBlocked
  >;
}
