import type { WaitOutcomeV1 } from '@cat-cafe/shared';

export function renderGitHubWaitOutcome(outcome: WaitOutcomeV1): string {
  const isIssue = outcome.subjectRef.startsWith('issue:');
  const subject = outcome.subjectRef.slice(isIssue ? 'issue:'.length : 'pr:'.length);
  const lines = [`🔔 **${isIssue ? 'Issue' : 'PR'} wait satisfied** — ${subject}`, ''];

  if (outcome.reason === 'subject_terminal') {
    lines.push(`- ${isIssue ? 'Issue' : 'PR'} state: ${outcome.terminalSubjectState ?? 'closed'}`);
  } else {
    for (const match of outcome.matched ?? []) {
      lines.push(`- ${match.delta}`);
    }
  }

  lines.push('', `Matched reason: \`${outcome.reason}\``);
  if (outcome.nextStep) lines.push(`Next: ${outcome.nextStep}`);
  return lines.join('\n');
}
