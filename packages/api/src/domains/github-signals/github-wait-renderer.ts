import type { WaitOutcomeV1 } from '@cat-cafe/shared';

export const REVIEW_LOOP_BRAKE_NEXT_STEP = '[review-loop-brake]';
export const REVIEW_LOOP_HISTORY_WARN_NEXT_STEP = '[review-loop-history-unavailable] ';
const REVIEW_LOOP_BRAKE_THRESHOLD = 4;

export type GitHubReviewLoopBrake =
  | { readonly kind: 'pause_once'; readonly formalChangesRequested: number }
  | { readonly kind: 'continue'; readonly formalChangesRequested: number }
  | { readonly kind: 'warn_open'; readonly reason: string };

export function classifyGitHubReviewLoopBrake(
  history: readonly { readonly id: number; readonly state: string; readonly author: string }[],
  newDecisionIds: readonly number[],
  prAuthorLogin?: string,
): GitHubReviewLoopBrake {
  const author = prAuthorLogin?.toLowerCase();
  const formalChangesRequested = history.filter(
    (review) => review.state === 'CHANGES_REQUESTED' && (!author || review.author.toLowerCase() !== author),
  );
  const newIds = new Set(newDecisionIds);
  const previousCount = formalChangesRequested.filter((review) => !newIds.has(review.id)).length;
  return previousCount < REVIEW_LOOP_BRAKE_THRESHOLD && formalChangesRequested.length >= REVIEW_LOOP_BRAKE_THRESHOLD
    ? { kind: 'pause_once', formalChangesRequested: formalChangesRequested.length }
    : { kind: 'continue', formalChangesRequested: formalChangesRequested.length };
}

export function renderGitHubWaitOutcome(outcome: WaitOutcomeV1): string {
  const isIssue = outcome.subjectRef.startsWith('issue:');
  const subject = outcome.subjectRef.slice(isIssue ? 'issue:'.length : 'pr:'.length);
  const kind = isIssue ? 'Issue' : 'PR';
  const lines =
    outcome.reason === 'expired'
      ? [`⏰ **${kind} tracking expired** — ${subject}`, '']
      : [`🔔 **${kind} wait satisfied** — ${subject}`, ''];

  // A terminal outcome — a final state or a deadline — first lists what its last poll observed.
  for (const match of outcome.matched ?? []) {
    // #1392 AC-7: the delta states the fact; the source ref is how the woken owner verifies it. The
    // body is deliberately absent, so without this pointer the wake would be unactionable.
    lines.push(match.sourceRef ? `- ${match.delta} (${match.sourceRef})` : `- ${match.delta}`);
  }
  /**
   * #1392 AC-7: an anomaly travels the normal path, and says so in the normal place.
   *
   * When identity or role could not be determined the audience filter was never applied, so this
   * delivery proves an event happened and proves nothing about coverage. Saying only "wait
   * satisfied" would let the owner read an unfiltered firehose as a working rule, which is the
   * mistake this issue exists to stop — the one party who can act is the one who cannot otherwise
   * notice. Recipients are unchanged: an unknown role never widens who is told.
   */
  if (outcome.matched?.some((match) => match.identityUnknown)) {
    lines.push(
      '',
      '⚠ **GitHub identity or role unknown** — the comments above were delivered unfiltered, and the',
      'accepted author/maintainer audience was never applied. Normal coverage is NOT established: treat',
      'this as "something happened here", verify who is involved, then decide whether to discuss or',
      'ignore. Re-register once identity resolves to get the filtered audience back.',
    );
  }
  if (outcome.reason === 'subject_terminal' || outcome.terminalSubjectState) {
    lines.push(`- ${kind} state: ${outcome.terminalSubjectState ?? 'closed'}`);
  }
  if (outcome.reason === 'expired') {
    lines.push(
      outcome.matched?.length
        ? '- The explicit deadline passed.'
        : '- The explicit deadline passed before anything matched.',
    );
  }

  lines.push('', `Matched reason: \`${outcome.reason}\``);
  if (outcome.nextStep === REVIEW_LOOP_BRAKE_NEXT_STEP) {
    lines.push(
      '⛔ Automatic re-request paused once after four formal changes-requested reviews.',
      'Next: Re-read the accepted source and write a Finding Pattern Summary before deciding the next review action.',
    );
  } else if (outcome.nextStep?.startsWith(REVIEW_LOOP_HISTORY_WARN_NEXT_STEP)) {
    lines.push('⚠ Review history unavailable; R4 counting is warn-open and does not block the owner wake.');
    lines.push(`Next: ${outcome.nextStep.slice(REVIEW_LOOP_HISTORY_WARN_NEXT_STEP.length)}`);
  } else if (outcome.nextStep) {
    lines.push(`Next: ${outcome.nextStep}`);
  }
  lines.push('', trackingStatusLine(outcome));
  return lines.join('\n');
}

/**
 * #1392: every delivery says what happens to the tracking itself. The failures the issue opened
 * with — an expired deadline, a consumed one-shot wait, a notification chain nobody re-armed —
 * were all silent about exactly this. A failed rearm is stated as a failure and never phrased so
 * that it could be read as "still watching".
 */
function trackingStatusLine(outcome: WaitOutcomeV1): string {
  if (outcome.renewal === 'rearmed') return '_Tracking continues — watching for the next event._';
  if (outcome.renewal === 'rearm_failed') {
    return '⚠ **Event delivered; tracking not rearmed.** Nothing is watching this subject now — register again to keep tracking.';
  }
  return `_Tracking ended (\`${outcome.reason}\`)._`;
}
