import type {
  CandidateInteractionDraft,
  InteractionEventId,
  MaterializableClaimPayload,
  OwnerMemoryActionEvidence,
  PersonClaimId,
  PersonId,
  PersonMemoryDeletionReceipt,
  PersonMemoryOwnerActionKind,
} from '@cat-cafe/shared';

interface OwnerActionBase {
  personId: PersonId;
  requestId: string;
}

export interface CorrectOwnerClaimCommand extends OwnerActionBase {
  action: 'correct_claim';
  claimId: PersonClaimId;
  expectedRevision: string;
  payload: MaterializableClaimPayload;
}

export interface RetireOwnerClaimCommand extends OwnerActionBase {
  action: 'retire_claim';
  claimId: PersonClaimId;
  expectedRevision: string;
}

export interface AmendOwnerEventCommand extends OwnerActionBase {
  action: 'amend_event';
  eventId: InteractionEventId;
  expectedRevision: string;
  payload: CandidateInteractionDraft['payload'];
}

export interface HardForgetOwnerPersonCommand extends OwnerActionBase {
  action: 'hard_forget_person';
  expectedPersonRevision: string;
  confirmed: true;
}

export type OwnerMemoryActionCommand =
  | CorrectOwnerClaimCommand
  | RetireOwnerClaimCommand
  | AmendOwnerEventCommand
  | HardForgetOwnerPersonCommand;

export interface ExecuteOwnerMemoryActionInput {
  ownerUserId: string;
  command: OwnerMemoryActionCommand;
  requestDigest: string;
  evidence: OwnerMemoryActionEvidence;
}

export interface OwnerMemoryActionAppliedProjection {
  action: PersonMemoryOwnerActionKind;
  outcome: 'applied' | 'replayed';
  itemId?: string;
  revision?: string;
  receipt?: PersonMemoryDeletionReceipt;
}

export type OwnerMemoryActionExecutionResult =
  | OwnerMemoryActionAppliedProjection
  | {
      action: PersonMemoryOwnerActionKind;
      outcome:
        | 'not_available'
        | 'stale_revision'
        | 'source_unavailable'
        | 'idempotency_conflict'
        | 'mutation_unavailable';
    };

export type OwnerMemoryActionReplayResult =
  | { outcome: 'none' }
  | { outcome: 'idempotency_conflict' }
  | { outcome: 'replayed'; result: OwnerMemoryActionAppliedProjection };

export interface OwnerMemoryActionStore {
  resolveOwnerActionReplay(input: {
    ownerUserId: string;
    command: OwnerMemoryActionCommand;
    requestDigest: string;
  }): Promise<OwnerMemoryActionReplayResult>;
  executeOwnerAction(input: ExecuteOwnerMemoryActionInput): Promise<OwnerMemoryActionExecutionResult>;
}
