import type { ArtifactReviewResponse, ReviewedMediaAsset } from './artifact-review.js';
import type {
  ContentModificationCompletionRule,
  ContentModificationRequest,
  ContentTextProposal,
} from './content-modification.js';
import type { ContentRuntimeControl } from './content-modification-control.js';
import type { RoutingPreflightDecisionV1 } from './routing-context-projections.js';
import type { WorkspaceContentReview } from './workspace-content-review.js';

export interface ContentModificationProgress {
  sourceMessageId?: string;
  prepared?:
    | {
        kind: 'media';
        contentRef: string;
        ownerRevision: number;
        ledgerRef?: string;
        legacyReview?: { reviewId: string; round: number };
      }
    | { kind: 'text'; reviewId: string; sourceRevision: string };
  task?: { taskId: string; revision: number; receiptRef: string };
  review?: { reviewId: string; round?: number; receiptRef: string };
}
export interface ContentModificationRecord {
  requestId: string;
  ownerUserId: string;
  payload: ContentModificationRequest;
  progress: ContentModificationProgress;
  revision: number;
  createdAt: number;
  updatedAt: number;
  issue?: { code: string; retryable: boolean; detail?: string };
  control?: ContentModificationCancellation;
}
/** Human cancellation intent and observed Task-owner receipts, independently of execution stopping. */
export interface ContentModificationCancellation {
  state: 'cancelled';
  actorId: string;
  cancelledAt: number;
  receiptRef: string;
  taskResolution: 'unknown' | 'closing' | 'preserved' | 'closed' | 'owner_changed';
  task?: { taskId: string; mode: 'close' | 'preserve'; observedRevision: number; dispositionRef?: string };
}
export interface ContentModificationRequestView {
  record: ContentModificationRecord;
  stage:
    | 'saving_source'
    | 'preparing_content'
    | 'admitting_task'
    | 'binding_request'
    | 'pending_delivery'
    | 'queued'
    | 'cancelled'
    | 'retired';
  delivery?: { messageId?: string; receiptRef: string };
  execution?: {
    state:
      | 'queued'
      | 'starting'
      | 'running'
      | 'finished'
      | 'failed'
      | 'cancelled'
      | 'interrupted'
      | 'withdrawn_running'
      | 'unknown';
    messageId: string;
    queueEntryId?: string;
    targetCatId: string;
    invocationId?: string;
    parentInvocationId?: string;
    observedAt: number;
    evidenceRef: string;
  };
}
export interface ContentModificationChoices {
  cats: {
    catId: string;
    name: string;
    /** Same-breed cats share `name`; the variant label tells them apart. */
    variantLabel?: string;
    mcpSupport: boolean;
    restrictions: readonly string[];
    preflight?: RoutingPreflightDecisionV1['targets'][number];
  }[];
  threads: { threadId: string; title: string | null }[];
}
export interface ContentModificationContextCatalogue {
  /** Authenticated publishing cat is a suggestion, not proof of original authorship. */
  suggestedCatId?: string;
  requests: ContentModificationRequestView[];
  contexts: {
    taskId: string;
    title: string;
    targetCatId: string;
    threadId: string;
    targetName: string;
    threadTitle: string;
    completionRule?: ContentModificationCompletionRule;
    requestIds: string[];
    state: 'active' | 'closed';
    taskContext?: ContentModificationRequest['taskContext'];
    publication?: { contentRef: string; ownerRevision: number };
  }[];
}
export type ContentModificationCandidate =
  | {
      kind: 'media';
      candidateRef: string;
      asset: ReviewedMediaAsset;
      authorCatId: string;
      responses: ArtifactReviewResponse[];
    }
  | { kind: 'text'; candidateRef: string; proposal: ContentTextProposal };
export interface ContentModificationAcceptance {
  requestId: string;
  ownerUserId: string;
  acceptOperationId: string;
  candidateRef: string;
  baseRevision: string;
  locator: { worktreeId: string; path: string };
  humanReceiptRef: string;
  fileReceiptRef: string;
  acceptedAt: number;
}
export interface ContentModificationRejection {
  requestId: string;
  candidateRef: string;
  ownerUserId: string;
  actorId: string;
  receiptRef: string;
  state: 'rejected';
  rejectedAt: number;
}
export interface ContentWritebackReceipt {
  receiptRef: string;
  ownerUserId: string;
  locator: { worktreeId: string; path: string };
  baseRevision: string;
  candidateRevision: string;
  requestId: string;
  candidateRef: string;
  acceptOperationId: string;
  state: 'intent' | 'prepared' | 'applied' | 'conflict' | 'unknown';
  appliedAt?: number;
  appliedSequence?: number;
  /** The operation's historical output; never a claim about the file's current bytes. */
  writtenRevision?: string;
  /** Byte digest observed at this readback; may differ after another edit. */
  currentRevision: string;
}
export interface ContentModificationDetailView extends ContentModificationRequestView {
  rejections?: ContentModificationRejection[];
  runtimeControls?: ContentRuntimeControl[];
  sourceDiscussions?: ContentSourceDiscussion[];
  writeback?: {
    originRequestId: string;
    locator: { worktreeId: string; path: string };
    baseRevision: string;
    writable: boolean;
  };
  candidates: ContentModificationCandidate[];
  acceptances: { acceptance: ContentModificationAcceptance; receipt: ContentWritebackReceipt | null }[];
  text?: {
    source: { text: string; source: { revision: string; locator: { worktreeId: string; path: string } } };
    proposals: ContentTextProposal[];
  };
}

/** The original owner snapshot is read-only evidence, never a second editable discussion. */
export interface ContentSourceDiscussion {
  requestId: string;
  title: string;
  readOnly: true;
  review: WorkspaceContentReview;
}
