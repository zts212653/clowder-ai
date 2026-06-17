/**
 * F222: In-memory FrustrationIssueStore — for tests and dev.
 */

import type { CreateFrustrationIssueInput, FrustrationIssue } from '@cat-cafe/shared';
import { createFrustrationIssue } from '@cat-cafe/shared';
import type { ConfirmIssueInput, IFrustrationIssueStore } from '../ports/FrustrationIssueStore.js';

function clone(issue: FrustrationIssue): FrustrationIssue {
  return JSON.parse(JSON.stringify(issue));
}

export class InMemoryFrustrationIssueStore implements IFrustrationIssueStore {
  private readonly issues = new Map<string, FrustrationIssue>();

  async create(input: CreateFrustrationIssueInput): Promise<FrustrationIssue> {
    const issue = createFrustrationIssue(input);
    this.issues.set(issue.issueId, issue);
    return clone(issue);
  }

  async getById(issueId: string): Promise<FrustrationIssue | null> {
    const issue = this.issues.get(issueId);
    return issue ? clone(issue) : null;
  }

  async confirm(input: ConfirmIssueInput): Promise<FrustrationIssue | null> {
    const issue = this.issues.get(input.issueId);
    if (!issue) return null;
    if (issue.status !== 'draft') return null;

    issue.status = 'confirmed';
    issue.confirmedAt = Date.now();
    if (input.userDescription) {
      issue.userDescription = input.userDescription;
    }
    return clone(issue);
  }

  async skip(issueId: string): Promise<FrustrationIssue | null> {
    const issue = this.issues.get(issueId);
    if (!issue) return null;
    if (issue.status !== 'draft') return null;

    issue.status = 'skipped';
    issue.skippedAt = Date.now();
    return clone(issue);
  }

  async markFalsePositive(issueId: string): Promise<FrustrationIssue | null> {
    const issue = this.issues.get(issueId);
    if (!issue) return null;
    if (issue.status !== 'draft') return null;

    issue.status = 'false_positive';
    issue.falsePositiveAt = Date.now();
    return clone(issue);
  }

  async setCardMessageId(issueId: string, cardMessageId: string): Promise<void> {
    const issue = this.issues.get(issueId);
    if (issue) {
      issue.cardMessageId = cardMessageId;
    }
  }

  async setCommunityIssueDraftId(issueId: string, draftId: string): Promise<void> {
    const issue = this.issues.get(issueId);
    if (issue) {
      issue.communityIssueDraftId = draftId;
    }
  }

  async listByThread(threadId: string): Promise<FrustrationIssue[]> {
    return Array.from(this.issues.values())
      .filter((i) => i.threadId === threadId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(clone);
  }

  async listConfirmed(userId: string): Promise<FrustrationIssue[]> {
    return Array.from(this.issues.values())
      .filter((i) => i.userId === userId && i.status === 'confirmed')
      .sort((a, b) => (b.confirmedAt ?? 0) - (a.confirmedAt ?? 0))
      .map(clone);
  }

  async listDraft(userId: string): Promise<FrustrationIssue[]> {
    return Array.from(this.issues.values())
      .filter((i) => i.userId === userId && i.status === 'draft')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(clone);
  }

  async listAll(userId: string): Promise<FrustrationIssue[]> {
    return Array.from(this.issues.values())
      .filter((i) => i.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(clone);
  }
}
