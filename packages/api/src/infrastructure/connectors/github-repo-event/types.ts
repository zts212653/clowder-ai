/**
 * F141: GitHub Repo Inbox — Types
 */

/** GitHub webhook event types we handle */
export type RepoEventAction = 'pull_request.opened' | 'pull_request.ready_for_review' | 'issues.opened';

/** Normalized signal from a GitHub repo event */
export interface RepoInboxSignal {
  readonly eventType: RepoEventAction;
  readonly repoFullName: string;
  readonly subjectType: 'pr' | 'issue';
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly authorLogin: string;
  readonly authorAssociation: string;
  readonly deliveryId: string;
  readonly action: string;
}

/** Config from env vars (KD-18) */
export interface GitHubRepoInboxConfig {
  readonly webhookSecret: string;
  readonly repoAllowlist: string[];
  readonly inboxCatId: string;
  readonly defaultUserId: string;
}
