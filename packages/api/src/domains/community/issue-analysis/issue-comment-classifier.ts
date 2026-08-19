import type { IssueCommentSuppressionReason } from '@cat-cafe/shared';
import { isCriticalIssueSignal } from './issue-fix-evidence.js';

export interface ClassifiableIssueComment {
  readonly body: string;
}

export interface IssueCommentClassification {
  readonly critical: boolean;
  readonly suppressionReason?: IssueCommentSuppressionReason;
}

export interface IssueCommentClassificationFilters<T extends ClassifiableIssueComment> {
  readonly isEchoComment?: (comment: T) => boolean;
  readonly isNoiseComment?: (comment: T) => boolean;
}

/**
 * Canonical issue-comment classification shared by every collection path.
 * Critical content wins before any exact suppression so a P0/security/data-loss
 * signal can never be hidden by an authenticated self echo or setup-noise match.
 */
export function classifyIssueComment<T extends ClassifiableIssueComment>(
  comment: T,
  filters: IssueCommentClassificationFilters<T> = {},
): IssueCommentClassification {
  if (isCriticalIssueSignal(comment.body)) return { critical: true };
  if (filters.isEchoComment?.(comment)) {
    return { critical: false, suppressionReason: 'exact_self_echo' };
  }
  if (filters.isNoiseComment?.(comment)) {
    return { critical: false, suppressionReason: 'exact_setup_noise' };
  }
  return { critical: false };
}
