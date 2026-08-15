import type {
  AutomationState,
  IssueAutomationState,
  IssueWaitAutomationState,
  PrAutomationState,
  ReviewAutomationState,
} from '@cat-cafe/shared';

export function automationGeneration(state: AutomationState | undefined): number | null {
  return state?.await?.generation ?? state?.waitOutcome?.generation ?? null;
}

function mergeReviewAutomationState(
  existing: ReviewAutomationState | undefined,
  patch: ReviewAutomationState,
): ReviewAutomationState {
  const merged: ReviewAutomationState = { ...existing, ...patch };
  const monotonic = (current: number | undefined, next: number | undefined) =>
    current !== undefined && next !== undefined ? Math.max(current, next) : (next ?? current);
  const legacy = monotonic(existing?.lastCommentCursor, patch.lastCommentCursor);
  const inline = monotonic(existing?.lastInlineCommentCursor, patch.lastInlineCommentCursor);
  const conversation = monotonic(existing?.lastConversationCommentCursor, patch.lastConversationCommentCursor);
  const decision = monotonic(existing?.lastDecisionCursor, patch.lastDecisionCursor);
  return {
    ...merged,
    ...(legacy !== undefined ? { lastCommentCursor: legacy } : {}),
    ...(inline !== undefined ? { lastInlineCommentCursor: inline } : {}),
    ...(conversation !== undefined ? { lastConversationCommentCursor: conversation } : {}),
    ...(decision !== undefined ? { lastDecisionCursor: decision } : {}),
  };
}

function mergeIssueAutomationState(
  existing: IssueAutomationState | undefined,
  patch: IssueAutomationState,
): IssueAutomationState {
  const merged: IssueAutomationState = { ...existing, ...patch };
  return {
    ...merged,
    lastCommentCursor:
      existing?.lastCommentCursor !== undefined && patch.lastCommentCursor !== undefined
        ? Math.max(existing.lastCommentCursor, patch.lastCommentCursor)
        : merged.lastCommentCursor,
    lastDeliveredCursor:
      existing?.lastDeliveredCursor !== undefined && patch.lastDeliveredCursor !== undefined
        ? Math.max(existing.lastDeliveredCursor, patch.lastDeliveredCursor)
        : merged.lastDeliveredCursor,
  };
}

/**
 * Merge collector state without allowing issue compatibility fields to leak
 * into the typed PR wait contract. Cursor sources remain monotonic.
 */
export function mergeTaskAutomationState(
  existing: AutomationState | undefined,
  patch: Partial<AutomationState>,
): AutomationState | undefined {
  if (!existing && Object.keys(patch).length === 0) return undefined;
  const subjectRef =
    patch.await?.subjectRef ??
    patch.waitOutcome?.subjectRef ??
    existing?.await?.subjectRef ??
    existing?.waitOutcome?.subjectRef;
  const issuePatch = patch as Partial<IssueWaitAutomationState>;
  const issueExisting = existing as IssueWaitAutomationState | undefined;
  const isIssueState =
    issuePatch.issue !== undefined || issueExisting?.issue !== undefined || subjectRef?.startsWith('issue:') === true;
  if (isIssueState) {
    const merged: IssueWaitAutomationState = {
      issue: issuePatch.issue
        ? mergeIssueAutomationState(issueExisting?.issue, issuePatch.issue)
        : issueExisting?.issue,
      closedAt: patch.closedAt ?? existing?.closedAt,
      await: issuePatch.await ?? issueExisting?.await,
      waitOutcome: patch.waitOutcome ?? existing?.waitOutcome,
    };
    return merged;
  }
  const prPatch = patch as Partial<PrAutomationState>;
  const prExisting = existing as PrAutomationState | undefined;
  const merged: PrAutomationState = {
    ci: prPatch.ci ? { ...prExisting?.ci, ...prPatch.ci } : prExisting?.ci,
    conflict: prPatch.conflict ? { ...prExisting?.conflict, ...prPatch.conflict } : prExisting?.conflict,
    review: prPatch.review ? mergeReviewAutomationState(prExisting?.review, prPatch.review) : prExisting?.review,
    closedAt: prPatch.closedAt ?? prExisting?.closedAt,
    await: prPatch.await ?? prExisting?.await,
    waitOutcome: prPatch.waitOutcome ?? prExisting?.waitOutcome,
  };
  return merged;
}
