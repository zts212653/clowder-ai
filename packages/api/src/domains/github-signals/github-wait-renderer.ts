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

  // #1392 AC-2: an expired outcome is a LOUD terminal, not a satisfied match. Say so plainly so
  // the owner knows tracking is over and nothing is armed — never render it as "wait satisfied".
  if (outcome.reason === 'expired') {
    return [
      `⏰ **${kind} tracking expired** — ${subject}`,
      '',
      '- Tracking window elapsed; no longer armed.',
      '',
      'Reason: `expired`',
    ].join('\n');
  }

  const lines = [`🔔 **${kind} wait satisfied** — ${subject}`, ''];

  if (outcome.reason === 'subject_terminal') {
    lines.push(`- ${isIssue ? 'Issue' : 'PR'} state: ${outcome.terminalSubjectState ?? 'closed'}`);
  } else {
    for (const match of outcome.matched ?? []) {
      lines.push(`- ${match.delta}`);
    }
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
  // #1392 AC-1: truthful rearm signal — tell the owner whether tracking continues after this
  // wake. Only a matched wake can auto-renew; subject_terminal is terminal (nothing to re-arm).
  if (outcome.reason === 'matched') {
    lines.push(outcome.autoRenewed ? '_Tracking re-armed for the next event._' : '_Tracking closed (single-fire)._');
  }
  return lines.join('\n');
}
