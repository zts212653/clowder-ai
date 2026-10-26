import type { ApprovalCardRef, ApprovalOriginRef, ApprovalPublication } from './approval-hub.js';
import type {
  EventMemoryCorrectionPatch,
  MemoryCorrectionReason,
  MemoryLifecycleStatus,
  TasteMemoryCorrectionPatch,
} from './memory-owner-lifecycle.js';
import type { CaptureCandidateState } from './person-memory.js';

export interface ProfileMemoryProposalView {
  proposalId: string;
  status: 'pending' | 'approving' | 'approved' | 'rejected';
  expectedRevision: string;
  suggestedContent: string;
  rationale: string;
  sourceCatId: string;
  sourceThreadId: string;
  createdAt: number;
  decisionEndpointBase: '/api/profile-updates';
  approvalState: ApprovalPublication['state'];
  approvalCardRef?: ApprovalCardRef;
  rejectionReason?: string;
}

export interface ProfileMemoryOwnerEntry {
  id: string;
  type: 'profile';
  layer: 'primer' | 'corpus' | 'capsule';
  relationshipKey: string | null;
  uri: string;
  title: string;
  status: 'active';
  revision: string;
  content: string;
  updatedAt?: number;
  proposals: ProfileMemoryProposalView[];
}

export interface ProfileMemoryOwnerBrowse {
  readStatus: 'ready' | 'unavailable';
  entries: ProfileMemoryOwnerEntry[];
  /** Absent effective capsule: creation base and drafts, never a fabricated active memory. */
  capsuleSetup?: { revision: string; proposals: ProfileMemoryProposalView[] };
}

export interface TasteTakeawayCandidate {
  status: 'pending_owner_confirmation';
  takeaway: string;
  basedOnRevision: string;
  candidateRevision: string;
}

export interface TasteMemoryLifecycleProjection {
  id: string;
  revision: string;
  status: MemoryLifecycleStatus;
  takeawayCandidate: TasteTakeawayCandidate | null;
  pendingCorrectionCount: number;
}

export interface TasteMemoryCorrectionProposalView {
  proposalId: string;
  status: 'pending' | 'approving' | 'approved' | 'rejected';
  expectedRevision: string;
  reason: MemoryCorrectionReason;
  suggestedPatch: TasteMemoryCorrectionPatch;
  sourceCatId: string;
  sourceThreadId: string;
  createdAt: number;
  rejectionReason?: string;
}

export interface TasteMemoryOwnerDetailLifecycleProjection extends TasteMemoryLifecycleProjection {
  correctionProposals: TasteMemoryCorrectionProposalView[];
}

export interface EntityMemoryProposalView {
  proposalId: string;
  status: 'pending' | 'approved' | 'rejected';
  suggestedPatch: {
    entityType: 'person' | 'cat' | 'feature' | 'concept' | 'external';
    canonicalName: string;
    aliases: string[];
    stance: string;
    visibilityScope: string;
  };
  rationale: string;
  sourceCatId: string;
  sourceThreadId: string;
  createdAt: number;
  decisionEndpointBase: '/api/entity-proposals';
  approvalState: ApprovalPublication['state'];
  approvalCardRef?: ApprovalCardRef;
  rejectionReason?: string;
}

export interface EntityMemoryOwnerEntry {
  id: string;
  type: 'entity';
  revision: string;
  status: MemoryLifecycleStatus;
  entityType: 'person' | 'cat' | 'feature' | 'concept' | 'external';
  canonicalName: string;
  aliases: string[];
  stance: string;
  visibilityScope: string;
  updatedAt: string;
  provenanceCount: number;
}

export interface EntityMemoryOwnerDetail extends EntityMemoryOwnerEntry {
  provenance: Array<{
    source: string;
    anchor?: string;
    threadId?: string;
    messageId?: string;
    date?: string;
  }>;
  proposals: EntityMemoryProposalView[];
}

export interface EntityMemoryOwnerBrowse {
  readStatus: 'ready' | 'unavailable';
  entries: EntityMemoryOwnerEntry[];
}

export interface PersonMemoryProposalView {
  proposalId: string;
  status: CaptureCandidateState;
  displayName: string;
  remainingDraftIds: string[];
  sourceCatId: string;
  sourceThreadId: string;
  createdAt: number;
  decisionEndpointBase: '/api/person-memory-proposals';
  approvalState: 'anchored';
  approvalCardRef?: ApprovalCardRef;
  replacesProposalId?: string;
}

export interface EventMemoryOwnerLifecycleProjection {
  revision: string;
  status: MemoryLifecycleStatus;
  pendingCorrectionCount: number;
}

export type EventMemoryCorrectionProposalStatus = 'pending' | 'approving' | 'approved' | 'rejected';

export interface EventMemoryCorrectionProposal {
  proposalId: string;
  status: EventMemoryCorrectionProposalStatus;
  eventId: string;
  expectedRevision: string;
  reason: MemoryCorrectionReason;
  suggestedPatch: EventMemoryCorrectionPatch;
  ownerUserId: string;
  sourceCatId: string;
  sourceThreadId: string;
  sourceInvocationId: string;
  source: { threadId: string; messageId: string };
  clientRequestId: string;
  createdAt: number;
  approvalOriginRef: ApprovalOriginRef;
  publication?: ApprovalPublication;
  approvedBy?: string;
  approvedAt?: number;
  rejectedBy?: string;
  rejectedAt?: number;
  rejectionReason?: string;
  appliedRevision?: string;
  cardMessageId?: string;
}

export interface EventMemoryCorrectionProposalView {
  proposalId: string;
  status: EventMemoryCorrectionProposalStatus;
  expectedRevision: string;
  reason: MemoryCorrectionReason;
  suggestedPatch: EventMemoryCorrectionPatch;
  sourceCatId: string;
  sourceThreadId: string;
  source: { threadId: string; messageId: string };
  createdAt: number;
  rejectionReason?: string;
  appliedRevision?: string;
}

export interface EventMemoryOwnerDetailLifecycleProjection extends EventMemoryOwnerLifecycleProjection {
  correctionProposals: EventMemoryCorrectionProposalView[];
}
