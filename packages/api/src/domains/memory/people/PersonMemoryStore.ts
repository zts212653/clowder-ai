import type {
  ApprovalEnvelope,
  ApprovalPublication,
  CandidateClaimDraft,
  CandidateClaimDraftId,
  CandidateInteractionDraft,
  CandidateRelationshipDraft,
  CaptureCandidateId,
  CaptureCandidateState,
  CatId,
  HumanDispositionFeedbackInput,
  HumanDispositionLedgerEntry,
  InteractionEvent,
  MaterializableClaimPayload,
  PersonClaimVersion,
  PersonId,
  PersonIdentity,
  PersonIdentityDraft,
  PersonMemoryDeletionReceipt,
  PersonMemoryResolvedSourceBundle,
  PersonMemorySourceRef,
  PersonMemorySuppressionToken,
  PersonRelationship,
} from '@cat-cafe/shared';

export interface StagePersonMemoryCandidateInput {
  candidateId: CaptureCandidateId;
  ownerUserId: string;
  requesterCatId: CatId;
  sourceMessageRef: PersonMemorySourceRef;
  personDraft: PersonIdentityDraft;
  targetPersonId?: PersonId;
  claimDrafts: CandidateClaimDraft[];
  relationshipDraft?: CandidateRelationshipDraft;
  interactionDraft?: CandidateInteractionDraft;
  sourceBundle: PersonMemoryResolvedSourceBundle;
  replacesProposalId?: CaptureCandidateId;
  remainingDraftIds: CandidateClaimDraftId[];
  retention: 'owner_controlled_no_ttl';
  createdAt: number;
}

export interface StoredPersonMemoryCandidate
  extends Omit<StagePersonMemoryCandidateInput, 'personDraft' | 'sourceBundle'> {
  personDraft?: PersonIdentityDraft;
  sourceBundle?: PersonMemoryResolvedSourceBundle;
  state: 'staged' | CaptureCandidateState;
  publication: ApprovalPublication;
  presentedAt?: number;
  notNowAt?: number;
  materializedPersonId?: PersonId;
  approval?: {
    approvedDraftIds: string[];
    authorizedAt: number;
  };
  latestDecisionId?: string;
  latestHumanDisposition?: HumanDispositionFeedbackInput;
  humanDispositionLedgerEntry?: HumanDispositionLedgerEntry;
  dispositionLineageBindingKey?: string;
  latestDecisionReceipt?: PersonMemoryDecisionReceipt;
  latestUndoReceipt?: PersonMemoryUndoReceipt;
  replacedByProposalId?: CaptureCandidateId;
}

export interface PersonMemoryDecisionReceipt {
  decisionId: string;
  candidateId: CaptureCandidateId;
  state: Extract<CaptureCandidateState, 'partially_materialized' | 'materialized'>;
  personId: PersonId;
  selectedDraftIds: CandidateClaimDraftId[];
  materializedClaimIds: string[];
  materializedRelationshipIds: string[];
  materializedEventIds: string[];
  remainingDraftIds: CandidateClaimDraftId[];
  decidedAt: number;
}

export interface UndoPersonMemoryDecisionInput {
  ownerUserId: string;
  candidateId: CaptureCandidateId;
  decisionId: string;
  requestId: string;
  undoneAt: number;
}

export interface PersonMemoryUndoReceipt {
  requestId: string;
  candidateId: CaptureCandidateId;
  decisionId: string;
  personId: PersonId;
  candidateState: Extract<CaptureCandidateState, 'pending_approval' | 'partially_materialized' | 'withdrawn'>;
  removed: {
    claims: number;
    relationships: number;
    events: number;
    person: number;
  };
  verdict: 'undone';
  undoneAt: number;
}

export type PersonMemoryUndoResult =
  | { outcome: 'applied' | 'replayed'; receipt: PersonMemoryUndoReceipt }
  | { outcome: 'conflict' | 'not_available' };

export type PersonMemoryDecisionResult =
  | { outcome: 'applied' | 'replayed'; receipt: PersonMemoryDecisionReceipt }
  | { outcome: 'conflict' }
  | { outcome: 'not_available' };

export interface ApprovePersonMemoryDraftsInput {
  ownerUserId: string;
  candidateId: CaptureCandidateId;
  selectedDraftIds: CandidateClaimDraftId[];
  decisionId: string;
  authorizedAt: number;
}

export interface RejectPersonMemoryCandidateInput {
  ownerUserId: string;
  candidateId: CaptureCandidateId;
  decisionId: string;
  feedback?: HumanDispositionFeedbackInput;
  decidedAt: number;
}

export type PersonMemoryRejectResult =
  | { outcome: 'applied' | 'replayed'; candidate: StoredPersonMemoryCandidate }
  | {
      outcome: 'conflict' | 'not_available' | 'legacy_disposition_unmigrated' | 'invariant_failure';
    };

export interface CorrectPersonClaimInput {
  ownerUserId: string;
  personId: PersonId;
  expectedCurrentClaimId: string;
  payload: MaterializableClaimPayload;
  sourceMessageRef: PersonMemorySourceRef;
  requestId: string;
  correctedAt: number;
}

export type PersonMemoryCorrectionResult =
  | { outcome: 'applied' | 'replayed'; claim: PersonClaimVersion }
  | { outcome: 'conflict' }
  | { outcome: 'not_available' };

export interface RetirePersonClaimInput {
  ownerUserId: string;
  personId: PersonId;
  expectedCurrentClaimId: string;
  sourceMessageRef: PersonMemorySourceRef;
  requestId: string;
  retiredAt: number;
}

export interface AmendPersonInteractionInput {
  ownerUserId: string;
  personId: PersonId;
  expectedEventId: string;
  payload: CandidateInteractionDraft['payload'];
  sourceMessageRef: PersonMemorySourceRef;
  requestId: string;
  amendedAt: number;
}

export type PersonMemoryAmendmentResult =
  | { outcome: 'applied' | 'replayed'; event: InteractionEvent }
  | { outcome: 'conflict' }
  | { outcome: 'not_available' };

export interface RedactPersonMemoryItemInput {
  ownerUserId: string;
  personId: PersonId;
  item: { kind: 'claim' | 'event'; id: string };
  requestId: string;
  redactedAt: number;
}

export type PersonMemoryRedactionResult =
  | { outcome: 'applied' | 'replayed'; item: RedactPersonMemoryItemInput['item'] }
  | { outcome: 'not_available' | 'conflict' };

export interface HardForgetPersonInput {
  ownerUserId: string;
  personId: PersonId;
  requestId: string;
  requestedAt: number;
}

export interface HardForgetPersonMemoryProposalInput {
  ownerUserId: string;
  proposalId: CaptureCandidateId;
  requestId: string;
  requestedAt: number;
}

export type PersonMemoryProposalForgetResult =
  | {
      outcome: 'purged' | 'already_absent';
      receipt: PersonMemoryDeletionReceipt;
    }
  | { outcome: 'person_bound' | 'conflict' };

export type PersonAliasResolution =
  | { status: 'resolved'; person: PersonIdentity }
  | { status: 'ambiguous'; people: PersonIdentity[] }
  | { status: 'not_available' };

export interface PersonMemoryStore {
  stageCandidate(input: StagePersonMemoryCandidateInput): Promise<StoredPersonMemoryCandidate>;
  getCandidateForOwner(ownerUserId: string, candidateId: string): Promise<StoredPersonMemoryCandidate | null>;
  listPending(ownerUserId: string, limit?: number): Promise<StoredPersonMemoryCandidate[]>;
  resolvePendingCandidateBySubject(ownerUserId: string, subject: string): Promise<StoredPersonMemoryCandidate | null>;
  resolveDormantCandidateBySubject(ownerUserId: string, subject: string): Promise<PersonMemorySuppressionToken | null>;
  getPublication(candidateId: string, ownerUserId?: string): Promise<ApprovalPublication | null>;
  commitEnvelope(candidateId: string, envelope: ApprovalEnvelope): Promise<void>;
  abortStaged(candidateId: string, reason: string): Promise<void>;
  approveDrafts(input: ApprovePersonMemoryDraftsInput): Promise<PersonMemoryDecisionResult>;
  undoDecision(input: UndoPersonMemoryDecisionInput): Promise<PersonMemoryUndoResult>;
  markNotNow(ownerUserId: string, candidateId: string, decidedAt: number): Promise<StoredPersonMemoryCandidate>;
  withdrawCandidate(ownerUserId: string, candidateId: string, decidedAt: number): Promise<StoredPersonMemoryCandidate>;
  rejectCandidate(input: RejectPersonMemoryCandidateInput): Promise<PersonMemoryRejectResult>;
  getPerson(ownerUserId: string, personId: PersonId): Promise<PersonIdentity | null>;
  resolveActivePersonByAlias(ownerUserId: string, alias: string): Promise<PersonAliasResolution>;
  resolveActivePersonByWorkspaceEntityRef(ownerUserId: string, entityRef: string): Promise<PersonAliasResolution>;
  listClaims(ownerUserId: string, personId: PersonId): Promise<PersonClaimVersion[]>;
  listRelationships(ownerUserId: string, personId: PersonId): Promise<PersonRelationship[]>;
  listInteractionEvents(ownerUserId: string, personId: PersonId): Promise<InteractionEvent[]>;
  correctClaim(input: CorrectPersonClaimInput): Promise<PersonMemoryCorrectionResult>;
  retireClaim(input: RetirePersonClaimInput): Promise<PersonMemoryCorrectionResult>;
  amendInteractionEvent(input: AmendPersonInteractionInput): Promise<PersonMemoryAmendmentResult>;
  redactItem(input: RedactPersonMemoryItemInput): Promise<PersonMemoryRedactionResult>;
  hardForget(input: HardForgetPersonInput): Promise<PersonMemoryDeletionReceipt>;
  hardForgetProposal(input: HardForgetPersonMemoryProposalInput): Promise<PersonMemoryProposalForgetResult>;
}
