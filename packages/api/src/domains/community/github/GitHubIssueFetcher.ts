import type { IssueState, IssueType } from '@cat-cafe/shared';

export interface GhIssueFull {
  number: number;
  title: string;
  state: string;
  labels: string[];
  comments: number;
  user: string;
  html_url: string;
}

const DECLINED_LABELS = new Set(['invalid', 'duplicate', 'wontfix']);
const CLOSED_LABELS = new Set(['fixed-internal']);

export function mapGitHubIssue(gh: GhIssueFull): { issueType: IssueType; state: IssueState } {
  const labels = new Set(gh.labels);

  let issueType: IssueType = 'feature';
  if (labels.has('bug')) issueType = 'bug';
  else if (labels.has('enhancement')) issueType = 'enhancement';
  else if (labels.has('question')) issueType = 'question';

  let state: IssueState;
  if (gh.state === 'closed') {
    state = 'closed';
  } else if ([...labels].some((l) => CLOSED_LABELS.has(l))) {
    state = 'closed';
  } else if ([...labels].some((l) => DECLINED_LABELS.has(l))) {
    state = 'declined';
  } else if (labels.has('accepted')) {
    state = 'accepted';
  } else if (labels.has('needs-maintainer-decision') || labels.has('needs-info')) {
    state = 'pending-decision';
  } else if (gh.comments > 0) {
    state = 'discussing';
  } else {
    state = 'unreplied';
  }

  return { issueType, state };
}
