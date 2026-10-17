import { isDeepStrictEqual } from 'node:util';
import type { FrustrationIssue } from '@cat-cafe/shared';

/** Internal material snapshot, including private source history. Never return this projection to plugins.
 * Card visibility and the independently compared navigation link are deliberately excluded.
 */
function material(issue: FrustrationIssue) {
  return {
    issueId: issue.issueId,
    status: issue.status,
    threadId: issue.threadId,
    userId: issue.userId,
    signalType: issue.signalType,
    signalDetail: issue.signalDetail,
    context: issue.context,
    userDescription: issue.userDescription,
    createdAt: issue.createdAt,
    confirmedAt: issue.confirmedAt,
  };
}

export function sameFrustrationSource(a: FrustrationIssue, b: FrustrationIssue): boolean {
  return isDeepStrictEqual(material(a), material(b));
}
