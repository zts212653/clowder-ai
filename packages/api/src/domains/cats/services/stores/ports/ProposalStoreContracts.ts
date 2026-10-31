import type {
  ApprovalEnvelope,
  ApprovalPublication,
  CatId,
  DeclaredWorkMode,
  DevelopmentScopeV1,
  ProposalApproveOverrides,
  ReportingMode,
  ThreadProposal,
} from '@cat-cafe/shared';
import type { SettledHistoryPageOptions, SettledHistorySourcePage } from '../../../../../utils/settled-history-page.js';
import type {
  ApprovedTaskContinuationInput,
  ApprovedTaskContinuationResult,
  MemoryContinuationAuthority,
} from '../../../../ball-custody/approved-task-continuation.js';

export interface CreateProposalInput {
  sourceThreadId: string;
  sourceInvocationId: string;
  sourceCatId: CatId;
  sourceMessageId: string;
  title: string;
  reason: string;
  parentThreadId: string;
  preferredCats: CatId[];
  projectPath: string;
  initialMessage?: string;
  suggestedGroupId?: string;
  suggestedPinned?: boolean;
  groupSuggestionReason?: ThreadProposal['groupSuggestionReason'];
  supersedesProposalId?: string;
  /** F128: reporting mode for the created thread (default final-only if omitted). */
  reportingMode?: ReportingMode;
  /** F277: declared placement role; omitted only for legacy proposals. */
  declaredWorkMode?: DeclaredWorkMode;
  createdBy: string;
  /**
   * Optional explicit proposalId. When supplied, the store uses this value instead of
   * generating one. Used by the propose route to reserve a dedup key BEFORE creating
   * the proposal, ensuring losers in a concurrent retry never produce orphan records.
   */
  proposalId?: string;
  /**
   * F167 × F322: Server-validated task binding. When set, the proposal is bound to
   * this exact task — only delegation claims for this task can consume the approval.
   * Must be validated by the route handler against the task store before persisting.
   */
  subjectTaskId?: string;
  /**
   * F167 R4: Immutable snapshot of the task title at creation time, derived by the
   * server from the validated task. Displayed on the operator approval card + audit trail.
   */
  subjectTaskTitle?: string;
  /**
   * F167 R5: Immutable scope snapshot from `task.entrustedWork.developmentScope`,
   * derived by the server at creation time. Never caller-supplied.
   */
  approvedDevelopmentScope?: DevelopmentScopeV1;
}

export interface ClaimForApprovalInput {
  proposalId: string;
  approvedBy: string;
}

export interface FinalizeApprovalInput {
  proposalId: string;
  createdThreadId: string;
  overrides?: ProposalApproveOverrides;
}

export interface RejectProposalInput {
  proposalId: string;
  rejectedBy: string;
  rejectionReason?: string;
}

export interface WithdrawProposalInput {
  proposalId: string;
  withdrawnBy: CatId;
}

export interface IProposalStore {
  recordRevisionRequest(
    proposalId: string,
    request: NonNullable<ThreadProposal['revisionRequest']>,
  ): ThreadProposal | null | Promise<ThreadProposal | null>;
  supersedePending(
    proposalId: string,
    replacementId: string,
    requestMessageId: string,
  ): ThreadProposal | null | Promise<ThreadProposal | null>;
  continueApprovedTask(
    input: ApprovedTaskContinuationInput,
    memoryAuthority?: MemoryContinuationAuthority,
  ): ApprovedTaskContinuationResult | Promise<ApprovedTaskContinuationResult>;
  create(input: CreateProposalInput): ThreadProposal | Promise<ThreadProposal>;
  get(proposalId: string): ThreadProposal | null | Promise<ThreadProposal | null>;
  listByUser(userId: string, limit?: number): ThreadProposal[] | Promise<ThreadProposal[]>;
  listSettledPage?(
    owner: string,
    options: SettledHistoryPageOptions,
  ): SettledHistorySourcePage<ThreadProposal> | Promise<SettledHistorySourcePage<ThreadProposal>>;
  listSettledByUser(userId: string, limit?: number): ThreadProposal[] | Promise<ThreadProposal[]>;
  listPending(userId: string, limit?: number): ThreadProposal[] | Promise<ThreadProposal[]>;
  listByThread(threadId: string, limit?: number): ThreadProposal[] | Promise<ThreadProposal[]>;
  /** Complete authority scan; unlike product lists, this must not truncate. */
  listAllByThread(threadId: string): ThreadProposal[] | Promise<ThreadProposal[]>;
  /**
   * Atomic CAS pending → approving. Returns the claimed proposal snapshot, or null if status
   * was not pending (e.g. already approved/rejected/claimed). Caller MUST call finalizeApproval
   * or rollbackClaim afterwards.
   */
  claimForApproval(input: ClaimForApprovalInput): ThreadProposal | null | Promise<ThreadProposal | null>;
  /** CAS approving → approved. Returns updated proposal or null if status drifted. */
  finalizeApproval(input: FinalizeApprovalInput): ThreadProposal | null | Promise<ThreadProposal | null>;
  /**
   * Persist `createdThreadId` on an approving proposal WITHOUT changing status.
   * Caller invokes this immediately after threadStore.create succeeds, BEFORE
   * finalizeApproval. This makes the partial-commit state idempotently recoverable:
   * if the process dies between create and finalize, the proposal records which
   * thread already exists — stale-claim recovery can then re-finalize instead of
   * rolling back (which would cause a duplicate thread on the next approve).
   * Optional overrides are checkpointed with the thread id so stale recovery preserves the
   * approval contract even if the process dies before finalizeApproval.
   * No-op if proposal status is not 'approving'.
   */
  recordCreatedThread(proposalId: string, threadId: string, overrides?: ProposalApproveOverrides): void | Promise<void>;
  /** CAS approving → pending. Used when thread creation fails after claim. */
  rollbackClaim(proposalId: string): boolean | Promise<boolean>;
  /** CAS pending → rejected. Returns null if status is not pending (e.g. already approving/approved). */
  markRejected(input: RejectProposalInput): ThreadProposal | null | Promise<ThreadProposal | null>;
  /** CAS pending → withdrawn. Requester identity is authorized by the callback route before this store transition. */
  withdrawPending(input: WithdrawProposalInput): ThreadProposal | null | Promise<ThreadProposal | null>;
  /** Idempotency: return cached proposalId for (userId, clientRequestId) if any. */
  getDedupProposalId(userId: string, clientRequestId: string): string | null | Promise<string | null>;
  /**
   * Idempotency: try to reserve (userId, clientRequestId) → proposalId atomically.
   * Returns the proposalId actually stored — caller's value if newly reserved, or the existing
   * value if a concurrent request beat it. Use the returned value as the canonical proposalId.
   */
  reserveDedup(userId: string, clientRequestId: string, proposalId: string): string | Promise<string>;
  /**
   * Mark the proposal as visible by recording the rich-card messageId that was appended to the
   * source thread. Until this is set, dedup fast paths must treat the proposal as in-flight
   * and not return it as a successful prior result.
   */
  setCardMessageId(proposalId: string, cardMessageId: string): void | Promise<void>;
  /**
   * Hard delete: remove proposal record and all index entries. Used to clean up after a
   * partial-commit failure during propose (e.g. proposal created but its card message
   * failed to post). Idempotent — no error if the proposal is already gone.
   */
  delete(proposalId: string): void | Promise<void>;
  /**
   * Idempotency cleanup: release the dedup reservation IF it currently points at expectedProposalId.
   * Used when `create` fails after a successful reservation, so retries can reclaim the key.
   * No-op if the key is missing or points at a different proposalId (defensive: never wipe
   * someone else's winning reservation).
   */
  releaseDedup(userId: string, clientRequestId: string, expectedProposalId: string): void | Promise<void>;
  getPublication(proposalId: string): ApprovalPublication | null | Promise<ApprovalPublication | null>;
  commitEnvelope(proposalId: string, envelope: ApprovalEnvelope): void | Promise<void>;
  abortStaged(proposalId: string, reason: string): void | Promise<void>;
}
