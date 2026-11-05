'use client';
import type {
  ApprovalHubItem,
  EntityConflictContext,
  EntityConflictResolutionRequest,
  HumanDispositionFeedbackInput,
} from '@cat-cafe/shared';
import { useCallback, useMemo, useRef, useState } from 'react';
import { approvalFeatureMeta } from '@/lib/approval-features';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { type ApprovalWriteKind, useApprovalHost, useGuardedWrite, useReportEditing } from './ApprovalHost';
import { HumanDispositionFeedbackDialog } from './HumanDispositionFeedbackDialog';
/** The existing domain writers, host guards, conflict resolution and rejection feedback shared by their surfaces. */
export function useApprovalItemActions(
  item: ApprovalHubItem,
  beforeWrite?: (kind: ApprovalWriteKind) => Promise<boolean>,
  afterWrite?: () => Promise<void>,
) {
  const isStale = useMemo(() => item.expiresAt != null && item.expiresAt < Date.now(), [item.expiresAt]);
  const isPersonMemoryClaimSelect = item.sourceFeatureId === 'F276' && item.decisionMode === 'claim-select';
  const approveProposal = useApprovalHubStore((state) => state.approveProposal);
  const rejectProposal = useApprovalHubStore((state) => state.rejectProposal);
  const decisionError = useApprovalHubStore((state) => state.error);
  const resolveEntityConflict = useApprovalHubStore((state) => state.resolveEntityConflict);
  const decidingState = useApprovalHubStore((state) => state.deciding[item.proposalId]);
  const entityConflict =
    item.sourceFeatureId === 'F260' && isEntityConflictContext(item.detail.conflict) ? item.detail.conflict : undefined;
  const featureMeta = approvalFeatureMeta(item.sourceFeatureId);
  const feedbackReasonCodes = featureMeta.humanDispositionReasonCodes;
  const usesFeedbackDialog = !isStale && feedbackReasonCodes !== null;

  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [feedbackDialogError, setFeedbackDialogError] = useState<string | null>(null);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);

  const guardedWrite = useGuardedWrite();
  const { writesLocked, presentation } = useApprovalHost();
  const preparing = useRef(false);
  const [checking, setChecking] = useState(false);
  const prepare = useCallback(
    async (kind: ApprovalWriteKind) => {
      if (writesLocked || preparing.current) return false;
      preparing.current = true;
      setChecking(true);
      try {
        return beforeWrite ? await beforeWrite(kind) : true;
      } finally {
        preparing.current = false;
        setChecking(false);
      }
    },
    [beforeWrite, writesLocked],
  );
  // A feedback dialog that is open is a decision in progress, whether or not a word has been typed yet.
  useReportEditing('feedback-dialog', feedbackDialogOpen);

  const handleApprove = useCallback(async () => {
    if (!(await prepare('approve'))) return;
    await guardedWrite('approve', () => approveProposal(item.proposalId));
    await afterWrite?.();
  }, [afterWrite, approveProposal, guardedWrite, item.proposalId, prepare]);

  const handleReject = useCallback(async () => {
    if (usesFeedbackDialog) {
      setFeedbackDialogError(null);
      setFeedbackSubmitted(false);
      setFeedbackDialogOpen(true);
      return;
    }
    if (!(await prepare('reject'))) return;
    await guardedWrite('reject', () => rejectProposal(item.proposalId));
    await afterWrite?.();
  }, [afterWrite, guardedWrite, item.proposalId, prepare, rejectProposal, usesFeedbackDialog]);

  const handleEntityResolution = useCallback(
    async (resolution: EntityConflictResolutionRequest) => {
      if (!(await prepare('entity-resolve'))) return;
      await guardedWrite('entity-resolve', () => resolveEntityConflict(item.proposalId, resolution));
      await afterWrite?.();
    },
    [afterWrite, guardedWrite, item.proposalId, prepare, resolveEntityConflict],
  );

  const submitReject = useCallback(
    async (feedback: HumanDispositionFeedbackInput | undefined) => {
      if (!(await prepare('reject-feedback'))) return;
      // Refused by the host (writes are locked): nothing was sent, so the dialog stays as the user left it.
      const written = await guardedWrite('reject-feedback', async () => {
        setFeedbackSubmitted(true);
        setFeedbackDialogError(null);
        return rejectProposal(item.proposalId, feedback);
      });
      if (!written.sent) return;
      await afterWrite?.();
      if (written.value) {
        setFeedbackDialogOpen(false);
        setFeedbackSubmitted(false);
        return;
      }
      setFeedbackDialogError('拒绝失败，请检查提案状态后重试。');
    },
    [afterWrite, guardedWrite, item.proposalId, prepare, rejectProposal],
  );

  return {
    isStale,
    isPersonMemoryClaimSelect,
    decidingState,
    checking,
    entityConflict,
    handleApprove,
    handleReject,
    handleEntityResolution,
    presentation,
    feedbackDialog: (
      <>
        {feedbackReasonCodes && (
          <HumanDispositionFeedbackDialog
            open={feedbackDialogOpen}
            reasonCodes={feedbackReasonCodes}
            subjectLabel={item.summary}
            submitting={decidingState === 'rejecting'}
            submitLocked={writesLocked}
            error={feedbackSubmitted ? (feedbackDialogError ?? decisionError) : null}
            onCancel={() => {
              setFeedbackDialogOpen(false);
              setFeedbackDialogError(null);
              setFeedbackSubmitted(false);
            }}
            onSubmit={(feedback) => void submitReject(feedback)}
          />
        )}
      </>
    ),
  };
}

function isEntityConflictContext(value: unknown): value is EntityConflictContext {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<EntityConflictContext>;
  return (
    candidate.version === 1 &&
    (candidate.reason === 'existing-entity-change' || candidate.reason === 'surface-collision') &&
    typeof candidate.fingerprint === 'string' &&
    typeof candidate.incoming === 'object' &&
    Array.isArray(candidate.candidates) &&
    Array.isArray(candidate.allowedActions)
  );
}
