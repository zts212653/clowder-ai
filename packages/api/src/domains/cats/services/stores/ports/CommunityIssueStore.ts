/**
 * Community Issue Store Port (F168)
 * Repo-agnostic community issue lifecycle tracking.
 */

import type { CommunityIssueItem, CreateCommunityIssueInput, UpdateCommunityIssueInput } from '@cat-cafe/shared';

export interface ICommunityIssueStore {
  create(input: CreateCommunityIssueInput): Promise<CommunityIssueItem | null>;
  get(id: string): Promise<CommunityIssueItem | null>;
  getByRepoAndNumber(repo: string, issueNumber: number): Promise<CommunityIssueItem | null>;
  listByRepo(repo: string): Promise<CommunityIssueItem[]>;
  listAll(): Promise<CommunityIssueItem[]>;
  update(id: string, input: UpdateCommunityIssueInput): Promise<CommunityIssueItem | null>;
  delete(id: string): Promise<boolean>;
}
